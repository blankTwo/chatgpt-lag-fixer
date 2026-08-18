/* ChatGPT 卡顿修复 —— 第二轮诊断（确认方案方向）
 *
 * 用法：在那个「很卡」的对话页面，F12 → Console，粘贴运行。
 * 这次不用赶时机：它用 Performance API 回看页面加载以来的所有网络请求。
 * 建议先【刷新页面】，等对话完全加载，再粘贴运行。
 * 把全部输出整段贴回来。
 */
(() => {
  const line = "─".repeat(52);
  const log = (...a) => console.log("%c[诊断2]", "color:#10a37f;font-weight:bold", ...a);
  console.log(line);
  log("对话 URL:", location.href);

  // ── 1. 回看页面加载以来所有对话相关的网络请求（含首屏）──
  const res = performance.getEntriesByType("resource");
  const convReqs = res
    .filter((r) => /backend-api\/conversation|\/conversation\//.test(r.name))
    .map((r) => ({
      url: r.name.slice(0, 120),
      type: r.initiatorType, // fetch / xmlhttprequest / other
      ms: Math.round(r.duration),
      transferKB: Math.round((r.transferSize || 0) / 1024),
    }));
  log("首屏至今的对话相关请求（Performance 回看）：");
  if (convReqs.length === 0) {
    console.log("  ❌ 没有任何 conversation 请求 —— 数据可能来自 SSR/内联/SW 缓存，不走可拦截的 fetch");
  } else {
    console.table(convReqs);
  }
  console.log("  说明：initiatorType 若为 'fetch' 才可能被我们的 fetch hook 拦到；'other'/SW 拦不到。");

  // ── 2. 真实对话规模：数所有 turn，并测最大单条消息的 DOM 重量 ──
  const turns = document.querySelectorAll('[data-testid^="conversation-turn"], [data-message-id]');
  let heaviest = { id: null, nodes: 0 };
  turns.forEach((t) => {
    const n = t.getElementsByTagName("*").length;
    if (n > heaviest.nodes) heaviest = { id: t.getAttribute("data-message-id") || t.getAttribute("data-testid"), nodes: n };
  });
  const totalNodes = document.getElementsByTagName("*").length;
  log("DOM 规模：");
  console.log("  当前渲染的 turn 数：", turns.length);
  console.log("  页面 DOM 元素总数：", totalNodes);
  console.log("  最重的单条消息 DOM 元素数：", heaviest.nodes, "（", heaviest.id, "）");
  console.log("  重型内容统计：",
    "代码块", document.querySelectorAll("pre").length,
    "| 表格", document.querySelectorAll("table").length,
    "| KaTeX", document.querySelectorAll(".katex").length,
    "| 图片", document.querySelectorAll("img").length,
    "| SVG", document.querySelectorAll("svg").length);

  // ── 3. 滚到顶部，看 DOM 是否随滚动增长（判断是否已虚拟化）──
  log("现在自动滚动到对话顶部，2 秒后再数一次 turn（判断是否虚拟化）……");
  const scroller =
    document.querySelector('[class*="react-scroll-to-bottom"]') ||
    document.querySelector("main") ||
    document.scrollingElement;
  const beforeTurns = turns.length;
  const beforeNodes = totalNodes;
  try { scroller.scrollTo({ top: 0, behavior: "auto" }); } catch (e) { window.scrollTo(0, 0); }

  setTimeout(() => {
    const afterTurns = document.querySelectorAll('[data-testid^="conversation-turn"], [data-message-id]').length;
    const afterNodes = document.getElementsByTagName("*").length;
    console.log(line);
    log("诊断2 汇总");
    console.log("  滚动前 turn 数 / 元素数：", beforeTurns, "/", beforeNodes);
    console.log("  滚到顶后 turn 数 / 元素数：", afterTurns, "/", afterNodes);
    if (afterTurns > beforeTurns * 1.3 || afterNodes > beforeNodes * 1.3) {
      console.log("  ▶ 结论：滚动使 DOM 显著增长 → ChatGPT 未充分虚拟化，长对话确实会堆 DOM（fetch/DOM 裁剪有意义）");
    } else if (afterTurns <= beforeTurns + 2) {
      console.log("  ▶ 结论：滚动后 DOM 基本不变 → ChatGPT 很可能已自带虚拟化，卡顿多半来自重型内容或滚动加载，而非 DOM 总量");
    } else {
      console.log("  ▶ 结论：DOM 有一定增长，介于两者之间，需结合上面的『最重消息 / 重型内容』判断");
    }
    console.log(line);
    log("请把从『[诊断2] 对话 URL』到这里的全部输出整段贴回来。");
  }, 2000);
})();
