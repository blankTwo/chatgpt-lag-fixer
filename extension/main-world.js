/* main-world.js — MAIN world，document_start，纯 IIFE（无 import，避开 CSP）
 *
 * 关键设计（吸取上一版教训）：
 *   1. 同步地、立刻挂钩 window.fetch —— 抢在 ChatGPT 首屏拉对话之前。
 *      wasm 是异步加载的；在它就绪之前，hook 会原样放行请求（只是暂不裁剪），
 *      绝不会因为"等 wasm"而漏装 hook。
 *   2. 不使用任何 import / 动态 import，因此不受 chatgpt.com 严格 CSP 影响。
 *   3. wasm 字符串封送使用与单测相同的 @assemblyscript/loader（vendor/as-loader.js
 *      已在本脚本之前注入，挂在 window.loader 上）。
 */
(() => {
  "use strict";
  if (window.__CLF_PATCHED__) return;

  const KEY_CONFIG = "clf_config";
  const KEY_EXTRA = "clf_extra_messages";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  // ── wasm 状态 ────────────────────────────────────────────
  let wasm = null;     // loader 实例的 exports
  let wasmReady = false;
  // 首屏请求可能早于 wasm 加载完成。用一个 promise 让 fetch hook 能"等一下"
  // wasm 就绪后再裁剪首屏对话（否则首屏会全量渲染，正是长对话打开时变慢的原因）。
  let resolveWasmReady;
  const wasmReadyPromise = new Promise((res) => { resolveWasmReady = res; });
  const WASM_WAIT_TIMEOUT = 3000; // 兜底：最多等 3s，wasm 万一加载失败也不卡住请求

  function log(cfg, ...a) {
    if (cfg && cfg.debug) console.log("[CLF]", ...a);
  }

  // ── 配置 / extra 读取（来自 page-inject 镜像的页面 localStorage）──
  function readConfig() {
    try {
      const raw = localStorage.getItem(KEY_CONFIG);
      if (raw) {
        const s = JSON.parse(raw);
        return {
          enabled: s.enabled ?? DEFAULTS.enabled,
          keepTurns: Math.max(1, s.keepTurns ?? DEFAULTS.keepTurns),
          debug: s.debug ?? DEFAULTS.debug,
        };
      }
    } catch (e) {
      /* 忽略 */
    }
    return { ...DEFAULTS };
  }

  function convIdFromUrl(url) {
    const m = String(url).match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function readExtra(convId) {
    if (!convId) return 0;
    try {
      const raw = localStorage.getItem(KEY_EXTRA);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.convId === convId) return p.extra || 0;
      }
    } catch (e) {
      /* 忽略 */
    }
    return 0;
  }

  function postStatus(payload) {
    window.postMessage({ source: "clf", type: "clf-status", payload }, "*");
  }

  // ── wasm 加载（异步，不阻塞 hook 安装）────────────────────
  async function loadWasm() {
    try {
      const url = document.documentElement.dataset.clfWasmUrl;
      if (!url) {
        console.error("[CLF] 未找到 wasm URL（page-inject 未运行？）");
        return;
      }
      if (!window.loader) {
        console.error("[CLF] as-loader 未加载（vendor/as-loader.js 未注入？）");
        return;
      }
      const bytes = await (await fetch(url)).arrayBuffer();
      const mod = await window.loader.instantiate(bytes, {
        env: {
          abort(_m, _f, line, col) {
            console.error("[CLF] wasm abort，位置 " + line + ":" + col);
          },
        },
      });
      wasm = mod.exports;
      wasmReady = true;
      const c = readConfig();
      log(c, "wasm 已就绪 → 启用裁剪:", c.enabled, "| 保留最近轮数:", c.keepTurns, "| 调试:", c.debug);
    } catch (e) {
      console.error("[CLF] 加载 wasm 失败:", e);
    } finally {
      // 无论成功失败都要 resolve，让等待首屏的 fetch hook 能继续（失败时按不裁剪放行）。
      if (resolveWasmReady) resolveWasmReady();
    }
  }

  // 喂给 wasm 前精简 mapping：只保留结构与 role/hidden，丢掉消息正文等无关字段。
  // wasm 的裁剪算法只看这几个字段，长对话下这一步能把传入 wasm 的 JSON 从数 MB
  // 降到几十 KB，显著减少 stringify / 内存拷贝 / wasm 内 JSON 解析的开销（首屏更快）。
  function slimForWasm(convObj) {
    const src = convObj.mapping;
    const out = {};
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
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

  // ── 裁剪单个对话对象；无需/不可裁剪时返回 null ────────────
  function trim(convObj, keepTurns, extra) {
    if (!wasmReady) return null;
    const json = JSON.stringify(slimForWasm(convObj));
    const ptr = wasm.__newString(json);
    wasm.__pin(ptr);
    try {
      const outPtr = wasm.trimConversation(ptr, keepTurns, extra);
      if (outPtr === 0) return null;
      const out = wasm.__getString(outPtr);
      if (!out) return null;
      return JSON.parse(out);
    } catch (e) {
      console.error("[CLF] wasm 裁剪出错:", e);
      return null;
    } finally {
      wasm.__unpin(ptr);
    }
  }

  // ── 把 wasm 裁剪结果合并回原始对话（保留完整 message 负载）──
  function applyTrim(original, result) {
    const mapping = {};
    for (const id of Object.keys(result.mapping)) {
      const tn = result.mapping[id];
      const on = original.mapping ? original.mapping[id] : undefined;
      mapping[id] = {
        id,
        message: on ? on.message ?? null : null,
        parent: tn.parent ?? null,
        children: Array.isArray(tn.children) ? tn.children : [],
      };
    }
    return { ...original, mapping, current_node: result.current_node };
  }

  function makeResponse(original, bodyObj) {
    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    const res = new Response(JSON.stringify(bodyObj), {
      status: original.status,
      statusText: original.statusText,
      headers,
    });
    try {
      Object.defineProperty(res, "url", { value: original.url });
    } catch (e) {
      /* 某些环境 url 只读，忽略 */
    }
    return res;
  }

  function isConversationGet(url, method) {
    return (
      method === "GET" &&
      url.indexOf("/backend-api/conversation") !== -1 &&
      url.indexOf("/backend-api/conversations") === -1
    );
  }

  async function processResponse(response, cfg) {
    let text;
    try {
      text = await response.clone().text();
    } catch (e) {
      return response;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let conv;
    try {
      conv = JSON.parse(text);
    } catch (e) {
      return response;
    }
    if (!conv || !conv.mapping || !conv.current_node) return response;

    const convId =
      convIdFromUrl(location.href) ||
      (conv.conversation_id ? String(conv.conversation_id).toLowerCase() : null);
    const extra = readExtra(convId);

    const budget = cfg.keepTurns + extra;
    log(
      cfg,
      "当前配置 →",
      "启用裁剪:", cfg.enabled,
      "| 保留最近轮数(keepTurns):", cfg.keepTurns,
      "| 加载更早(extra):", extra,
      "| 实际预算(budget=keepTurns+extra):", budget,
      "| 会话:", convId
    );

    const result = trim(conv, cfg.keepTurns, extra);
    if (!result) {
      log(cfg, "跳过裁剪（无需裁剪或 wasm 未就绪）");
      return response;
    }

    postStatus({
      conversationId: convId,
      visibleTotal: result.visibleTotal,
      visibleKept: result.visibleKept,
      absoluteMessageCount: result.absoluteMessageCount,
      hasOlderMessages: result.hasOlderMessages,
      extra,
    });

    if (!result.hasOlderMessages) return response;

    log(
      cfg,
      "已裁剪 " + result.visibleTotal + " -> " + result.visibleKept +
        " 个可见轮次（预算 " + budget + " = keepTurns " + cfg.keepTurns + " + extra " + extra + "）"
    );
    return makeResponse(response, applyTrim(conv, result));
  }

  // ── 同步安装 fetch hook（最先执行的关键动作）──────────────
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1];
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      (init && init.method) || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const cfg = readConfig();
    if (!cfg.enabled || !isConversationGet(url, method)) {
      return originalFetch.apply(this, args);
    }

    // 首屏关键点：这是对话请求但 wasm 还没就绪时，先等它（带超时兜底），
    // 这样首屏就能裁剪，而不是全量渲染后再等下一次请求。与原扩展对齐。
    if (!wasmReady) {
      log(cfg, "首屏对话请求，等待 wasm 就绪…");
      await Promise.race([
        wasmReadyPromise,
        new Promise((res) => setTimeout(res, WASM_WAIT_TIMEOUT)),
      ]);
    }

    const response = await originalFetch.apply(this, args);
    try {
      return await processResponse(response, cfg);
    } catch (e) {
      log(cfg, "处理响应出错:", e);
      return response;
    }
  };
  window.__CLF_PATCHED__ = true;
  console.log("[CLF] fetch hook 已安装（MAIN world）");

  // hook 装好后再异步加载 wasm。
  loadWasm();
})();
