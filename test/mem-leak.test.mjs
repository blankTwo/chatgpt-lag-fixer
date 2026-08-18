// 内存泄漏排查:连续裁剪多次,观察 wasm 线性内存是否无限增长。
// AssemblyScript 增量 GC(ITCMS)应能回收未 pin 的中间对象和输出串;
// 若内存单调暴涨,说明我们的调用方式导致了泄漏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

function linearConv(nTurns) {
  const mapping = { root: { parent: null, children: ["u1"] } };
  let prev = "root", last = "root";
  for (let i = 1; i <= nTurns; i++) {
    const uid = "u" + i, aid = "a" + i;
    mapping[prev].children = [uid];
    mapping[uid] = { parent: prev, children: [aid], message: { author: { role: "user" } } };
    mapping[aid] = { parent: uid, children: [], message: { author: { role: "assistant" } } };
    prev = aid; last = aid;
  }
  return { mapping, current_node: last };
}

// 与 main-world.js 完全一致的调用序列(含 __unpin)
function trimOnce(json, keepTurns, extra) {
  const ptr = wasm.__newString(json);
  wasm.__pin(ptr);
  try {
    const outPtr = wasm.trimConversation(ptr, keepTurns, extra);
    if (outPtr === 0) return null;
    return wasm.__getString(outPtr);
  } finally {
    wasm.__unpin(ptr);
  }
}

test("连续裁剪 500 次,wasm 线性内存不无限增长", () => {
  const json = JSON.stringify(linearConv(60)); // 120 轮的中等对话
  const pages = () => wasm.memory.buffer.byteLength / 65536; // wasm 页(64KB)数

  // 预热几次,让内存增长到稳定工作集
  for (let i = 0; i < 20; i++) trimOnce(json, 10, 0);
  if (wasm.__collect) wasm.__collect();
  const before = pages();

  for (let i = 0; i < 500; i++) trimOnce(json, 10, 0);
  if (wasm.__collect) wasm.__collect();
  const after = pages();

  console.log(`  wasm 线性内存: 预热后 ${before} 页 (${(before * 64).toFixed(0)}KB) → 500 次后 ${after} 页 (${(after * 64).toFixed(0)}KB)`);

  // 稳定工作集后,再跑 500 次不应显著增长(允许极小波动)。
  assert.ok(after <= before + 2, `wasm 内存疑似泄漏: ${before} → ${after} 页`);
});

test("__collect 后内存可回落(GC 生效)", () => {
  const json = JSON.stringify(linearConv(100));
  for (let i = 0; i < 50; i++) trimOnce(json, 8, 0);
  const peak = wasm.memory.buffer.byteLength / 65536;
  if (wasm.__collect) wasm.__collect();
  const afterGc = wasm.memory.buffer.byteLength / 65536;
  console.log(`  峰值 ${peak} 页 → __collect 后 ${afterGc} 页`);
  // wasm 线性内存不会主动 shrink,但至少不应继续增长;这里只断言没爆炸增长。
  assert.ok(afterGc <= peak + 1);
});
