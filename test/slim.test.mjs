// 验证:喂 wasm 前的"精简 mapping"步骤(main-world.js 的 slimForWasm)不改变
// 裁剪结果,且确实剥离了消息正文。复刻 main-world.js 里的 slimForWasm 逻辑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 载入 extension/ 打包的 UMD loader(与线上一致)
const loaderSrc = readFileSync(path.resolve(__dirname, "../extension/vendor/as-loader.js"), "utf8");
const sandbox = { WebAssembly, TextDecoder, TextEncoder, console };
sandbox.globalThis = sandbox;
new Function("globalThis", "self", "window",
  "var define=undefined, exports=undefined, module=undefined;\n" + loaderSrc)(sandbox, sandbox, sandbox);
const loader = sandbox.loader;

const bytes = readFileSync(path.resolve(__dirname, "../extension/trimmer.wasm"));
const mod = await loader.instantiate(bytes, {
  env: { abort(_m, _f, l, c) { throw new Error("wasm abort " + l + ":" + c); } },
});
const wasm = mod.exports;

// 与 main-world.js 完全一致的精简逻辑
function slimForWasm(convObj) {
  const src = convObj.mapping;
  const out = {};
  for (const id of Object.keys(src)) {
    const node = src[id];
    if (!node) continue;
    const slim = { parent: node.parent != null ? node.parent : null };
    if (Array.isArray(node.children)) slim.children = node.children;
    const msg = node.message;
    if (msg) {
      const m = { author: { role: msg.author ? msg.author.role : undefined } };
      const meta = msg.metadata;
      if (meta && meta.is_visually_hidden_from_conversation != null) {
        m.metadata = { is_visually_hidden_from_conversation: meta.is_visually_hidden_from_conversation };
      }
      slim.message = m;
    }
    out[id] = slim;
  }
  return { mapping: out, current_node: convObj.current_node };
}

function trimSlim(convObj, keepTurns, extra) {
  const ptr = wasm.__newString(JSON.stringify(slimForWasm(convObj)));
  wasm.__pin(ptr);
  try {
    const outPtr = wasm.trimConversation(ptr, keepTurns, extra);
    return outPtr === 0 ? null : JSON.parse(wasm.__getString(outPtr));
  } finally {
    wasm.__unpin(ptr);
  }
}

// 构造带【大段正文】的完整对话(模拟真实 ChatGPT 节点)
function fatConv(nTurns) {
  const mapping = {};
  const bigText = "x".repeat(5000); // 每条消息 5KB 正文
  mapping["root"] = { id: "root", parent: null, children: ["sys"], message: null };
  mapping["sys"] = { id: "sys", parent: "root", children: ["u1"],
    message: { author: { role: "system" }, metadata: { is_visually_hidden_from_conversation: true }, content: { parts: [bigText] } } };
  let prev = "sys", last = "sys";
  for (let i = 1; i <= nTurns; i++) {
    const uid = "u" + i, aid = "a" + i;
    mapping[prev].children = [uid];
    mapping[uid] = { id: uid, parent: prev, children: [aid],
      message: { author: { role: "user" }, create_time: 1700000000 + i, content: { parts: [bigText] } } };
    mapping[aid] = { id: aid, parent: uid, children: [],
      message: { author: { role: "assistant" }, create_time: 1700000001 + i, content: { parts: [bigText] } } };
    prev = aid; last = aid;
  }
  return { mapping, current_node: last };
}

test("精简大幅缩小传入 wasm 的 JSON 体积", () => {
  const conv = fatConv(30);
  const full = JSON.stringify(conv).length;
  const slim = JSON.stringify(slimForWasm(conv)).length;
  assert.ok(slim < full * 0.1, `精简后应远小于原始: slim=${slim} full=${full}`);
});

test("精简后裁剪结果仍正确、无悬空引用", () => {
  const conv = fatConv(30);
  const res = trimSlim(conv, 5, 0);
  assert.ok(res);
  assert.equal(res.visibleTotal, 60);
  assert.equal(res.visibleKept, 5);
  assert.equal(res.hasOlderMessages, true);
  const ids = new Set(Object.keys(res.mapping));
  for (const id of ids) {
    for (const c of res.mapping[id].children || []) assert.ok(ids.has(c), "子引用悬空:" + c);
    if (res.mapping[id].parent != null) assert.ok(ids.has(res.mapping[id].parent), "父引用悬空");
  }
});

test("精简剥离了正文,wasm 输出里不含原始 content", () => {
  const conv = fatConv(10);
  const res = trimSlim(conv, 3, 0);
  assert.ok(res);
  assert.ok(!JSON.stringify(res).includes("xxxxx"), "wasm 输出不应含消息正文");
});
