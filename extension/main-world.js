/* main-world.js — MAIN world，document_start，纯 IIFE（无 import）
 *
 * 重建版原则：
 *   1. 只做一件事：拦截历史会话响应并用 WASM 裁剪数据。
 *   2. 不处理 iframe，不做 DOM 虚拟化，不做 content-visibility，不拦 XHR。
 *   3. 兼容两种历史接口：
 *      - 旧版 /backend-api/conversation/<id>：mapping + current_node，直接 WASM。
 *      - 新版 /backend-api/conversations/<id>：messages[] + current_node，先适配成 mapping，
 *        WASM 决定保留节点，再映射回原 messages[]。
 */
(() => {
  "use strict";
  if (window.__CLF_PATCHED__) return;

  const KEY_CONFIG = "clf_config";
  const KEY_EXTRA = "clf_extra_messages";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };
  const WASM_WAIT_TIMEOUT = 3000;
  const CONFIG_WAIT_TIMEOUT = 1200;
  const BUILD_SIGNATURE = "core-rebuild-v1";

  let wasm = null;
  let wasmReady = false;
  let resolveWasmReady;
  const wasmReadyPromise = new Promise((resolve) => { resolveWasmReady = resolve; });

  function log(cfg, ...args) {
    if (cfg?.debug) console.log("[CLF]", ...args);
  }

  function readConfig() {
    try {
      const raw = localStorage.getItem(KEY_CONFIG);
      if (raw) {
        const s = JSON.parse(raw);
        return {
          enabled: s.enabled ?? DEFAULTS.enabled,
          keepTurns: Math.max(1, Math.floor(Number(s.keepTurns) || DEFAULTS.keepTurns)),
          debug: s.debug ?? DEFAULTS.debug,
        };
      }
    } catch (_) {
      /* 忽略 */
    }
    return { ...DEFAULTS };
  }

  function waitForConfigReady() {
    if (document.documentElement.dataset.clfConfigReady === "1") return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (ready) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(ready);
      };
      const observer = new MutationObserver(() => {
        if (document.documentElement.dataset.clfConfigReady === "1") finish(true);
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-clf-config-ready"],
      });
      const timer = setTimeout(() => finish(false), CONFIG_WAIT_TIMEOUT);
    });
  }

  function convIdFromPage() {
    const m = String(location.href).match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function convIdFromApiUrl(url) {
    try {
      const path = new URL(String(url), location.origin).pathname;
      const m = path.match(/^\/backend-api\/conversations?\/([^/]+)\/?$/);
      return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  function readExtra(convId) {
    if (!convId) return 0;
    try {
      const raw = localStorage.getItem(KEY_EXTRA);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      return parsed.convId === convId ? Math.max(0, Number(parsed.extra) || 0) : 0;
    } catch (_) {
      return 0;
    }
  }

  function postStatus(payload) {
    window.postMessage({ source: "clf", type: "clf-status", payload }, "*");
  }

  async function loadWasm() {
    try {
      const url = document.documentElement.dataset.clfWasmUrl;
      if (!url) throw new Error("未找到 wasm URL（page-inject 未就绪）");
      if (!window.loader) throw new Error("as-loader 未加载");

      const bytes = await (await fetch(url)).arrayBuffer();
      const mod = await window.loader.instantiate(bytes, {
        env: {
          abort(_message, _file, line, col) {
            console.error(`[CLF] wasm abort，位置 ${line}:${col}`);
          },
        },
      });
      wasm = mod.exports;
      wasmReady = true;
      const cfg = readConfig();
      log(
        cfg,
        "wasm 已就绪 → 启用裁剪:", cfg.enabled,
        "| 保留最近轮数:", cfg.keepTurns,
        "| 调试:", cfg.debug,
      );
    } catch (error) {
      console.error("[CLF] 加载 wasm 失败:", error);
    } finally {
      resolveWasmReady?.();
    }
  }

  function slimForWasm(convObj) {
    const src = convObj.mapping;
    const out = {};
    for (const id of Object.keys(src || {})) {
      const node = src[id];
      if (!node) continue;
      const slim = {
        parent: node.parent != null ? node.parent : null,
        children: Array.isArray(node.children) ? node.children : [],
      };
      const msg = node.message;
      if (msg) {
        const role = msg.author?.role;
        const compact = { author: { role } };
        if (msg.metadata?.is_visually_hidden_from_conversation != null) {
          compact.metadata = {
            is_visually_hidden_from_conversation:
              msg.metadata.is_visually_hidden_from_conversation,
          };
        }
        slim.message = compact;
      }
      out[id] = slim;
    }
    return { mapping: out, current_node: convObj.current_node };
  }

  function trim(convObj, keepTurns, extra) {
    if (!wasmReady || !convObj?.mapping || !convObj?.current_node) return null;
    const ptr = wasm.__newString(JSON.stringify(slimForWasm(convObj)));
    wasm.__pin(ptr);
    try {
      const outPtr = wasm.trimConversation(ptr, keepTurns, extra);
      if (!outPtr) return null;
      const out = wasm.__getString(outPtr);
      return out ? JSON.parse(out) : null;
    } catch (error) {
      console.error("[CLF] wasm 裁剪出错:", error);
      return null;
    } finally {
      wasm.__unpin(ptr);
    }
  }

  function makeResponse(original, bodyObj) {
    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    const response = new Response(JSON.stringify(bodyObj), {
      status: original.status,
      statusText: original.statusText,
      headers,
    });
    try {
      Object.defineProperty(response, "url", { value: original.url });
    } catch (_) {
      /* 忽略 */
    }
    return response;
  }

  function requestKind(url, method) {
    if (method !== "GET") return "other";
    try {
      const path = new URL(String(url), location.origin).pathname;
      if (/^\/backend-api\/conversation\/[^/]+\/?$/.test(path)) return "legacy";
      if (/^\/backend-api\/conversations\/[^/]+\/?$/.test(path)) return "current";
      return "other";
    } catch (_) {
      return "other";
    }
  }

  function applyLegacyTrim(original, result) {
    const mapping = {};
    for (const id of Object.keys(result.mapping || {})) {
      const trimmed = result.mapping[id];
      const source = original.mapping?.[id];
      mapping[id] = {
        ...(source || {}),
        id: source?.id ?? id,
        message: source?.message ?? null,
        parent: trimmed.parent ?? null,
        children: Array.isArray(trimmed.children) ? trimmed.children : [],
      };
    }
    return { ...original, mapping, current_node: result.current_node };
  }

  async function processLegacy(response, cfg, convId, extra) {
    let body;
    try {
      body = await response.clone().json();
    } catch (_) {
      return response;
    }
    if (!body?.mapping || !body?.current_node) return response;

    const result = trim(body, cfg.keepTurns, extra);
    if (!result) return response;

    postStatus({
      conversationId: convId,
      visibleTotal: result.visibleTotal,
      visibleKept: result.visibleKept,
      absoluteMessageCount: result.absoluteMessageCount,
      hasOlderMessages: result.hasOlderMessages,
      extra,
    });

    log(
      cfg,
      "WASM 已裁剪 →",
      result.visibleTotal, "->", result.visibleKept,
      "个可见轮次 | endpoint: legacy",
    );

    if (!result.hasOlderMessages) return response;
    return makeResponse(response, applyLegacyTrim(body, result));
  }

  function itemId(item, index) {
    const value = item?.id ?? item?.message?.id ?? item?.message_id ?? item?.node_id;
    return value == null ? `__clf_msg_${index}` : String(value);
  }

  function itemMessage(item) {
    if (item?.message && typeof item.message === "object") return item.message;
    if (item?.author || item?.role || item?.metadata) return item;
    return null;
  }

  function itemParent(item) {
    const value = item?.parent ?? item?.parent_id ?? item?.parentId ?? null;
    if (value && typeof value === "object") {
      return value.id ?? value.message_id ?? null;
    }
    return value == null ? null : String(value);
  }

  function buildCurrentAdapter(messages, currentNode) {
    const rootId = "__clf_root__";
    const syntheticIds = [];
    const actualIds = [];
    const actualToSynthetic = new Map();
    const syntheticToActual = new Map();
    const used = new Set([rootId]);

    for (let i = 0; i < messages.length; i++) {
      const actual = itemId(messages[i], i);
      let synthetic = actual;
      if (used.has(synthetic)) synthetic = `__clf_msg_${i}`;
      let suffix = 1;
      while (used.has(synthetic)) synthetic = `__clf_msg_${i}_${suffix++}`;
      used.add(synthetic);
      syntheticIds.push(synthetic);
      actualIds.push(actual);
      if (!actualToSynthetic.has(actual)) actualToSynthetic.set(actual, synthetic);
      syntheticToActual.set(synthetic, actual);
    }

    const parents = new Array(messages.length);
    const hasTreeRelations = messages.some((item) =>
      itemParent(item) != null ||
      Array.isArray(item?.children) ||
      Array.isArray(item?.children_ids)
    );
    for (let i = 0; i < messages.length; i++) {
      const rawParent = itemParent(messages[i]);
      const mappedParent = rawParent != null ? actualToSynthetic.get(String(rawParent)) : null;
      if (mappedParent) parents[i] = mappedParent;
      else if (hasTreeRelations) parents[i] = rootId;
      else parents[i] = i === 0 ? rootId : syntheticIds[i - 1];
    }

    const childrenById = new Map([[rootId, []]]);
    for (const id of syntheticIds) childrenById.set(id, []);
    for (let i = 0; i < syntheticIds.length; i++) {
      const parent = parents[i] || rootId;
      const children = childrenById.get(parent) || [];
      children.push(syntheticIds[i]);
      childrenById.set(parent, children);
    }

    const mapping = {
      [rootId]: { parent: null, children: childrenById.get(rootId) || [], message: null },
    };
    for (let i = 0; i < messages.length; i++) {
      mapping[syntheticIds[i]] = {
        parent: parents[i] || rootId,
        children: childrenById.get(syntheticIds[i]) || [],
        message: itemMessage(messages[i]),
      };
    }

    const wantedCurrent = currentNode == null ? null : String(currentNode);
    const currentSynthetic =
      (wantedCurrent && actualToSynthetic.get(wantedCurrent)) ||
      syntheticIds[syntheticIds.length - 1] ||
      rootId;

    return {
      conversation: { mapping, current_node: currentSynthetic },
      rootId,
      syntheticIds,
      actualIds,
      syntheticToActual,
    };
  }

  function patchCurrentItem(item, trimmedNode, adapter) {
    if (!item || typeof item !== "object") return item;
    const hasTreeFields = ["parent", "parent_id", "parentId", "children", "children_ids"]
      .some((key) => Object.prototype.hasOwnProperty.call(item, key));
    if (!hasTreeFields) return item;

    const out = { ...item };
    const parentSynthetic = trimmedNode.parent;
    const parentActual =
      !parentSynthetic || parentSynthetic === adapter.rootId
        ? null
        : adapter.syntheticToActual.get(parentSynthetic) ?? null;
    const childrenActual = (trimmedNode.children || [])
      .filter((id) => id !== adapter.rootId)
      .map((id) => adapter.syntheticToActual.get(id))
      .filter(Boolean);

    if (Object.prototype.hasOwnProperty.call(item, "parent")) out.parent = parentActual;
    if (Object.prototype.hasOwnProperty.call(item, "parent_id")) out.parent_id = parentActual;
    if (Object.prototype.hasOwnProperty.call(item, "parentId")) out.parentId = parentActual;
    if (Object.prototype.hasOwnProperty.call(item, "children")) out.children = childrenActual;
    if (Object.prototype.hasOwnProperty.call(item, "children_ids")) out.children_ids = childrenActual;
    return out;
  }

  function rewriteCurrentRequest(args, url, minimumTurns) {
    const parsed = new URL(String(url), location.origin);
    const current = Math.max(0, Number(parsed.searchParams.get("num_turns")) || 0);
    const next = Math.max(current, Math.max(1, Math.floor(minimumTurns)));
    if (next === current) return { args, requestedTurns: current || null };

    parsed.searchParams.set("num_turns", String(next));
    const nextArgs = args.slice();
    const input = args[0];
    nextArgs[0] = input instanceof Request
      ? new Request(parsed.href, input)
      : parsed.href;
    return { args: nextArgs, requestedTurns: next };
  }

  async function processCurrent(response, cfg, convId, extra) {
    let body;
    try {
      body = await response.clone().json();
    } catch (_) {
      return response;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || !body?.current_node) {
      log(cfg, "新版历史响应结构不支持裁剪");
      return response;
    }

    const adapter = buildCurrentAdapter(messages, body.current_node);
    const result = trim(adapter.conversation, cfg.keepTurns, extra);
    if (!result) return response;

    const keep = new Set(Object.keys(result.mapping || {}));
    const filtered = [];
    const keptActualIds = [];

    for (let i = 0; i < messages.length; i++) {
      const syntheticId = adapter.syntheticIds[i];
      if (!keep.has(syntheticId)) continue;
      const trimmedNode = result.mapping[syntheticId];
      filtered.push(patchCurrentItem(messages[i], trimmedNode, adapter));
      keptActualIds.push(adapter.actualIds[i]);
    }

    const serverHasPreviousPage = Boolean(body?.page_info?.has_previous_page);
    const hasOlderMessages = Boolean(result.hasOlderMessages || serverHasPreviousPage);
    const lastActualId = keptActualIds[keptActualIds.length - 1] || body.current_node;
    const currentNode = keptActualIds.includes(String(body.current_node))
      ? body.current_node
      : lastActualId;

    let pageInfo = body.page_info;
    if (pageInfo && typeof pageInfo === "object") {
      pageInfo = { ...pageInfo };
      if (keptActualIds.length) {
        pageInfo.start_cursor = keptActualIds[0];
        pageInfo.end_cursor = keptActualIds[keptActualIds.length - 1];
      }
      // 固定窗口由扩展控制；“加载更早”通过 extra + reload 显式扩大窗口。
      pageInfo.has_previous_page = false;
    }

    postStatus({
      conversationId: convId,
      visibleTotal: result.visibleTotal,
      visibleKept: result.visibleKept,
      absoluteMessageCount: result.absoluteMessageCount,
      hasOlderMessages,
      extra,
    });

    log(
      cfg,
      "WASM 已裁剪 →",
      result.visibleTotal, "->", result.visibleKept,
      "个可见轮次 | messages:", messages.length, "->", filtered.length,
      "| endpoint: current",
      "| 原生上一页:", serverHasPreviousPage ? "blocked" : "none",
    );

    const mustRebuild =
      filtered.length !== messages.length ||
      serverHasPreviousPage ||
      currentNode !== body.current_node;
    if (!mustRebuild) return response;

    return makeResponse(response, {
      ...body,
      messages: filtered,
      current_node: currentNode,
      ...(pageInfo ? { page_info: pageInfo } : {}),
    });
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1];
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      (init?.method) ||
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const kind = requestKind(url, method);

    if (kind === "other") return originalFetch.apply(this, args);

    await waitForConfigReady();
    let cfg = readConfig();
    if (!cfg.enabled) return originalFetch.apply(this, args);

    if (!wasmReady) {
      log(cfg, "历史会话请求等待 wasm 就绪…");
      await Promise.race([
        wasmReadyPromise,
        new Promise((resolve) => setTimeout(resolve, WASM_WAIT_TIMEOUT)),
      ]);
    }

    cfg = readConfig();
    if (!cfg.enabled) return originalFetch.apply(this, args);

    const convId = convIdFromApiUrl(url) || convIdFromPage();
    const extra = readExtra(convId);
    const budget = cfg.keepTurns + extra;

    log(
      cfg,
      "命中历史会话请求 →",
      "endpoint:", kind,
      "| keepTurns:", cfg.keepTurns,
      "| extra:", extra,
      "| budget:", budget,
      "| 会话:", convId,
    );

    let requestArgs = args;
    if (kind === "current") {
      requestArgs = rewriteCurrentRequest(args, url, budget).args;
    }

    const response = await originalFetch.apply(this, requestArgs);
    try {
      return kind === "legacy"
        ? await processLegacy(response, cfg, convId, extra)
        : await processCurrent(response, cfg, convId, extra);
    } catch (error) {
      log(cfg, "处理历史响应失败，原样放行:", error);
      return response;
    }
  };

  window.__CLF_PATCHED__ = true;
  console.log("[CLF] fetch hook 已安装（MAIN world）| core:", BUILD_SIGNATURE);
  loadWasm();
})();
