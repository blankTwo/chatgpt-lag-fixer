/* page-inject.js — isolated world，document_start
 *
 * 桥接 MAIN world 无法访问的扩展 API：
 *   1. 把 wasm 的 web 可访问 URL 写到 <html> 的 dataset 上，供 MAIN world 加载
 *   2. 把 chrome.storage.local 里的设置镜像到页面 localStorage，供 MAIN world 同步读取
 *
 * 必须尽早执行（document_start），以便 MAIN world 脚本一运行就能拿到这两样东西。
 */
(() => {
  "use strict";

  const KEY_SETTINGS = "clf_settings";
  const KEY_CONFIG = "clf_config"; // 页面 localStorage 里的镜像键
  const KEY_EXTRA = "clf_extra_messages"; // "加载更早"的一次性额外预算（页面 localStorage）
  const KEY_LOAD_MORE_PENDING = "clf_load_more_pending"; // 仅允许显式“加载更早”的下一次 reload 继承 extra
  const LOAD_MORE_TTL_MS = 15000;
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  function convIdFromUrl(url) {
    const m = String(url).match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  // extra 不能跨普通刷新长期残留。只有用户刚刚点击“加载更早”触发的那一次 reload 才保留。
  // 否则旧 extra 会把 keepTurns=4 之类的设置悄悄放大成 24/44/...。
  try {
    const convId = convIdFromUrl(location.href);
    const raw = sessionStorage.getItem(KEY_LOAD_MORE_PENDING);
    let preserveExtra = false;
    if (raw && convId) {
      const pending = JSON.parse(raw);
      preserveExtra = pending.convId === convId && Date.now() - Number(pending.at || 0) <= LOAD_MORE_TTL_MS;
    }
    sessionStorage.removeItem(KEY_LOAD_MORE_PENDING);
    if (!preserveExtra) localStorage.removeItem(KEY_EXTRA);
  } catch (e) {
    try { sessionStorage.removeItem(KEY_LOAD_MORE_PENDING); } catch (_) { /* 忽略 */ }
    try { localStorage.removeItem(KEY_EXTRA); } catch (_) { /* 忽略 */ }
  }

  // 1. 暴露 wasm URL（以及扩展 id，便于调试）。
  try {
    document.documentElement.dataset.clfWasmUrl = chrome.runtime.getURL("trimmer.wasm");
    document.documentElement.dataset.clfExtId = chrome.runtime.id;
  } catch (e) {
    /* 忽略 */
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const keep = Number.isFinite(raw.keepTurns) ? Math.max(1, Math.floor(raw.keepTurns)) : DEFAULTS.keepTurns;
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      keepTurns: keep,
      debug: raw.debug ?? DEFAULTS.debug,
    };
  }

  function mirror(settings) {
    try {
      localStorage.setItem(KEY_CONFIG, JSON.stringify(normalize(settings)));
      document.documentElement.dataset.clfConfigReady = "1";
    } catch (e) {
      /* 忽略 */
    }
  }

  // 2. 首次镜像 + 监听后续变更。
  try {
    chrome.storage.local.get({ [KEY_SETTINGS]: DEFAULTS }, (data) => {
      mirror(data[KEY_SETTINGS]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY_SETTINGS]) {
        const oldV = changes[KEY_SETTINGS].oldValue;
        const newV = changes[KEY_SETTINGS].newValue;
        // keepTurns 变化时清掉累积的 extra，让"保留最近轮数"所见即所得
        // （否则之前"加载更早"残留的 extra 会叠加进裁剪预算）。
        const oldKeep = oldV && oldV.keepTurns;
        const newKeep = newV && newV.keepTurns;
        if (newKeep !== undefined && oldKeep !== newKeep) {
          try {
            localStorage.removeItem(KEY_EXTRA);
          } catch (e) {
            /* 忽略 */
          }
        }
        mirror(newV);
      }
    });
  } catch (e) {
    // storage 不可用时也要保证 MAIN world 有默认配置可读
    mirror(DEFAULTS);
  }

  // 3. 转发 MAIN world 上报的状态到 chrome.storage（供 popup 使用）。
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "clf" || d.type !== "clf-status") return;
    try {
      chrome.storage.local.set({ clf_last_status: d.payload });
    } catch (e) {
      /* 忽略 */
    }
  });
})();
