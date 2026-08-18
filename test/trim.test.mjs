// wasm 裁剪核心的正确性测试。
// 运行：node --test test/trim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import loader from "@assemblyscript/loader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, "../extension/trimmer.wasm");

const { exports } = await loader.instantiate(readFileSync(wasmPath), {
  env: {
    abort(msg, file, line, col) {
      throw new Error(`wasm abort，位置 ${line}:${col}`);
    },
  },
});

/** 调用 trimConversation 并解析 JSON 结果（空串时返回 null）。 */
function trim(conv, keepTurns, extra = 0) {
  const inPtr = exports.__newString(JSON.stringify(conv));
  exports.__pin(inPtr);
  const outPtr = exports.trimConversation(inPtr, keepTurns, extra);
  exports.__unpin(inPtr);
  const str = exports.__getString(outPtr);
  return str === "" ? null : JSON.parse(str);
}

/** 构造线性对话：root -> system -> (user, assistant) x nTurns。 */
function linearConv(nTurns) {
  const mapping = {};
  mapping["root"] = { id: "root", parent: null, children: ["sys"], message: null };
  mapping["sys"] = {
    id: "sys",
    parent: "root",
    children: ["u1"],
    message: { author: { role: "system" }, metadata: { is_visually_hidden_from_conversation: true } },
  };
  let prev = "sys";
  let last = "sys";
  for (let i = 1; i <= nTurns; i++) {
    const uid = "u" + i;
    const aid = "a" + i;
    mapping[prev].children = [uid];
    mapping[uid] = { id: uid, parent: prev, children: [aid], message: { author: { role: "user" } } };
    mapping[aid] = { id: aid, parent: uid, children: [], message: { author: { role: "assistant" } } };
    prev = aid;
    last = aid;
  }
  return { mapping, current_node: last };
}

/** 断言树中不存在悬空的 parent/children 引用。 */
function assertNoDangling(result) {
  const ids = new Set(Object.keys(result.mapping));
  for (const id of ids) {
    const node = result.mapping[id];
    for (const c of node.children || []) {
      assert.ok(ids.has(c), `节点 "${id}" 的子节点 "${c}" 悬空`);
    }
    if (node.parent != null) {
      assert.ok(ids.has(node.parent), `节点 "${id}" 的父节点 "${node.parent}" 悬空`);
    }
  }
}

/** 断言从 root 沿 children 出发能到达 current_node。 */
function assertReachable(result) {
  const seen = new Set();
  const stack = [result.root];
  while (stack.length) {
    const x = stack.pop();
    if (!x || seen.has(x) || !result.mapping[x]) continue;
    seen.add(x);
    for (const c of result.mapping[x].children || []) stack.push(c);
  }
  assert.ok(seen.has(result.current_node), "current_node 从 root 不可达");
}

test("透传：较短对话不被裁剪（返回完整树）", () => {
  const conv = linearConv(3); // 6 个可见轮次
  const res = trim(conv, 10, 0);
  assert.ok(res, "期望有结果");
  assert.equal(res.hasOlderMessages, false);
  assert.equal(res.visibleTotal, 6);
  assert.equal(res.visibleKept, 6);
  assertNoDangling(res);
  assertReachable(res);
});

test("裁剪：只保留最近的 N 个可见轮次", () => {
  const conv = linearConv(20); // 40 个可见轮次
  const res = trim(conv, 6, 0);
  assert.ok(res);
  assert.equal(res.visibleTotal, 40);
  assert.equal(res.visibleKept, 6);
  assert.equal(res.hasOlderMessages, true);
  assert.equal(res.absoluteMessageCount, 40);
  assertNoDangling(res);
  assertReachable(res);
});

test("裁剪：current_node 被保留且可达", () => {
  const conv = linearConv(30);
  const res = trim(conv, 4, 0);
  assert.ok(res);
  assert.equal(res.current_node, conv.current_node);
  assertReachable(res);
});

test("裁剪：extra 预算会保留更多更早的轮次", () => {
  const conv = linearConv(30);
  const base = trim(conv, 5, 0);
  const more = trim(conv, 5, 10);
  assert.ok(base && more);
  assert.ok(more.visibleKept > base.visibleKept, "extra 应保留更多");
  assert.equal(more.visibleKept, 15);
  assertNoDangling(more);
  assertReachable(more);
});

test("裁剪后无悬空引用（原扩展的 bug）", () => {
  const conv = linearConv(50);
  const res = trim(conv, 3, 0);
  assert.ok(res);
  assertNoDangling(res);
  // 每个保留的内容节点都能无间断地上溯到 root。
  assertReachable(res);
});

test("健壮性：非法/空输入返回空（不崩溃）", () => {
  assert.equal(trim({ mapping: {} }, 5, 0), null);
  const inPtr = exports.__newString("not json at all");
  const out = exports.trimConversation(inPtr, 5, 0);
  assert.equal(exports.__getString(out), "");
});

test("健壮性：缺少 current_node 时返回空", () => {
  const conv = linearConv(20);
  delete conv.current_node;
  assert.equal(trim(conv, 5, 0), null);
});

test("分支：只测量到 current_node 的活动分支", () => {
  // root -> sys -> u1 -> a1 -> u2 -> a2（活动），外加从 u1 分出的一条死分支
  const conv = linearConv(10);
  // 给 a1 的父节点添加一个不在当前路径上的兄弟 assistant 节点
  conv.mapping["u1"].children.push("dead1");
  conv.mapping["dead1"] = { id: "dead1", parent: "u1", children: [], message: { author: { role: "assistant" } } };
  const res = trim(conv, 4, 0);
  assert.ok(res);
  assertNoDangling(res);
  assertReachable(res);
  // 被裁掉后，死分支不应残留
  if (res.hasOlderMessages) {
    assert.ok(!("dead1" in res.mapping) || res.mapping["u1"] === undefined,
      "死掉的兄弟节点不应悬空");
  }
});
