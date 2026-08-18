/* ChatGPT 卡顿修复 —— 真机诊断探针
 *
 * 用法：
 *   1. 打开一个「很长、很卡」的 ChatGPT 对话页面
 *   2. 按 F12 打开控制台（Console）
 *   3. 把本文件全部内容粘贴进去，回车
 *   4. 正常滚动/等待几秒，再看输出；把控制台打印结果整段贴回来
 *
 * 它不修改页面，只做只读观测。
 */
(() => {
  const line = "─".repeat(52);
  const log = (...a) => console.log("%c[诊断]", "color:#10a37f;font-weight:bold", ...a);

  console.log(line);
  log("开始诊断", location.href);

  // ── 1. 我的扩展是否注入 ────────────────────────────────
  const el = document.documentElement;
  log("扩展注入检查：");
  console.log("  data-clf-wasm-url（bridge 注入）:", el.dataset.clfWasmUrl || "❌ 未发现");
  console.log("  window.__CLF_PATCHED__（fetch 已 hook）:", window.__CLF_PATCHED__ || "❌ false/未定义");
  try {
    console.log("  clf_config（页面 localStorage）:", localStorage.getItem("clf_config") || "❌ 无");
  } catch (e) {
    console.log("  clf_config 读取失败:", e.message);
  }

  // ── 2. fetch 是否被我们包过 ────────────────────────────
  const fetchStr = window.fetch.toString();
  const patched = fetchStr.includes("__CLF") || fetchStr.length < 200 === false;
  log("window.fetch 源码前 120 字符：");
  console.log("  ", fetchStr.slice(0, 120).replace(/\s+/g, " "));

  // ── 3. 监听真实的网络请求，看 ChatGPT 用什么拉对话 ──────
  log("开始监听后续 fetch/XHR 请求（10 秒）。请现在滚动或刷新对话……");
  const seen = [];
  const origFetch = window.fetch;
  const probeFetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (url.includes("/backend-api/") || url.includes("conversation")) {
      seen.push({ kind: "fetch", url: url.slice(0, 140) });
      console.log("  📡 fetch:", url.slice(0, 140));
    }
    return origFetch.apply(this, args);
  };
  window.fetch = probeFetch;

  const OrigXHR = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes("/backend-api/") || String(url).includes("conversation")) {
      seen.push({ kind: "xhr", url: String(url).slice(0, 140) });
      console.log("  📡 XHR:", String(url).slice(0, 140));
    }
    return OrigXHR.call(this, method, url, ...rest);
  };

  // ── 4. 数一数当前 DOM 里有多少消息节点（卡顿真正来源）──
  function countDom() {
    const selectors = [
      '[data-message-id]',
      '[data-testid^="conversation-turn"]',
      'article',
      '.text-base',
    ];
    const counts = {};
    for (const s of selectors) counts[s] = document.querySelectorAll(s).length;
    const totalNodes = document.getElementsByTagName("*").length;
    return { counts, totalNodes };
  }
  const before = countDom();
  log("当前 DOM 统计：");
  console.log("  消息节点候选：", before.counts);
  console.log("  页面 DOM 元素总数：", before.totalNodes);

  // ── 5. 10 秒后汇总 ─────────────────────────────────────
  setTimeout(() => {
    window.fetch = origFetch;
    window.XMLHttpRequest.prototype.open = OrigXHR;
    const after = countDom();
    console.log(line);
    log("诊断汇总");
    console.log("  ▶ 扩展 fetch hook 是否生效:", window.__CLF_PATCHED__ ? "✅ 是" : "❌ 否");
    console.log("  ▶ 观测到的对话相关请求数:", seen.length);
    console.table(seen);
    console.log("  ▶ DOM 消息节点（10 秒后）：", after.counts);
    console.log("  ▶ DOM 元素总数（10 秒后）：", after.totalNodes);
    console.log(line);
    log("请把从『开始诊断』到这里的全部输出整段复制给我。");
  }, 10000);
})();
