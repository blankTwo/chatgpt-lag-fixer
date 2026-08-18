// 端到端验证:完全复刻 main-world.js 里用 UMD as-loader 加载 wasm + 裁剪的路径。
// 目的:确认线上真正会用的 glue(window.loader.instantiate 返回的 exports 上的
// __newString/__getString/__pin/__unpin) 确实可用且裁剪结果正确。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载 extension/ 里实际打包的那份 UMD loader,并在模拟"普通 <script> 环境"下执行,
// 复刻线上 MAIN world 的加载方式(UMD 会把 API 挂到 global.loader,而非 ESM 导出)。
const loaderPath = path.resolve(__dirname, "../extension/vendor/as-loader.js");
const loaderSrc = readFileSync(loaderPath, "utf8");
// UMD 头部判断顺序:define(amd) -> exports(cjs) -> 否则挂 global.loader。
// 在一个干净沙盒里执行(无 define/exports/module),强制走 "global.loader" 分支,
// 复刻普通 <script> 注入 MAIN world 的行为。
const sandbox = { WebAssembly, TextDecoder, TextEncoder, console };
sandbox.globalThis = sandbox;
const runInSandbox = new Function(
  "globalThis", "self", "window",
  "var define=undefined, exports=undefined, module=undefined;\n" + loaderSrc
);
runInSandbox(sandbox, sandbox, sandbox);
const loader = sandbox.loader;

const wasmPath = path.resolve(__dirname, "../extension/trimmer.wasm");
const bytes = readFileSync(wasmPath);

const mod = await loader.instantiate(bytes, {
  env: {
    abort(_m, _f, line, col) {
      throw new Error("wasm abort " + line + ":" + col);
    },
  },
});
const wasm = mod.exports;

// 与 main-world.js 中的 trim() 完全相同的调用序列
function trim(convObj, keepTurns, extra) {
  const ptr = wasm.__newString(JSON.stringify(convObj));
  wasm.__pin(ptr);
  try {
    const outPtr = wasm.trimConversation(ptr, keepTurns, extra);
    if (outPtr === 0) return null;
    const out = wasm.__getString(outPtr);
    if (!out) return null;
    return JSON.parse(out);
  } finally {
    wasm.__unpin(ptr);
  }
}

function linearConv(nTurns) {
  const mapping = {};
  mapping["root"] = { id: "root", parent: null, children: ["sys"], message: null };
  mapping["sys"] = { id: "sys", parent: "root", children: ["u1"], message: { author: { role: "system" }, metadata: { is_visually_hidden_from_conversation: true } } };
  let prev = "sys", last = "sys";
  for (let i = 1; i <= nTurns; i++) {
    const uid = "u" + i, aid = "a" + i;
    mapping[prev].children = [uid];
    mapping[uid] = { id: uid, parent: prev, children: [aid], message: { author: { role: "user" } } };
    mapping[aid] = { id: aid, parent: uid, children: [], message: { author: { role: "assistant" } } };
    prev = aid; last = aid;
  }
  return { mapping, current_node: last };
}

test("UMD loader glue 可用:__newString/__getString 往返正常", () => {
  assert.equal(typeof wasm.__newString, "function", "__newString 应存在");
  assert.equal(typeof wasm.__getString, "function", "__getString 应存在");
  assert.equal(typeof wasm.__pin, "function");
  assert.equal(typeof wasm.trimConversation, "function");
});

test("端到端:长对话被正确裁剪且无悬空引用", () => {
  const res = trim(linearConv(30), 5, 0);
  assert.ok(res, "应返回裁剪结果");
  assert.equal(res.visibleTotal, 60);
  assert.equal(res.visibleKept, 5);
  assert.equal(res.hasOlderMessages, true);
  const ids = new Set(Object.keys(res.mapping));
  for (const id of ids) {
    for (const c of res.mapping[id].children || []) assert.ok(ids.has(c), "子引用悬空:" + c);
    if (res.mapping[id].parent != null) assert.ok(ids.has(res.mapping[id].parent), "父引用悬空");
  }
});

test("端到端:短对话透传(hasOlderMessages=false)", () => {
  const res = trim(linearConv(3), 15, 0);
  assert.ok(res);
  assert.equal(res.hasOlderMessages, false);
});
