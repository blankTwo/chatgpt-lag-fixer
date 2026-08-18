/* mem-probe.js — 内存对照测量探针
 *
 * 目的:对比"启用裁剪"和"关闭裁剪"两种状态下,长对话页面的 JS 堆内存与 DOM 规模,
 *      用数据判断我们的裁剪对内存到底有没有效。
 *
 * 用法(重要,要测两次):
 *   【A 组 - 启用裁剪】
 *     1. popup 里确保"启用裁剪"打开、保留最近轮数设一个较小值(如 8)
 *     2. 刷新长对话页面,等完全加载
 *     3. F12 控制台粘贴运行本脚本,记下输出
 *     4. 同时打开 Chrome 任务管理器(Shift+Esc)记下该标签页的"内存占用量"
 *   【B 组 - 关闭裁剪】
 *     5. popup 里关掉"启用裁剪",刷新页面,等完全加载
 *     6. 再次粘贴运行本脚本,记下输出 + 任务管理器内存
 *   把 A、B 两组数据都发给我对比。
 *
 * 注意:performance.memory 是 JS 堆,和任务管理器的进程总内存不是一回事,两者都要记。
 */
(() => {
  const log = (...a) => console.log("%c[内存探针]", "color:#10a37f;font-weight:bold", ...a);
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

  // 触发一次 GC 更难(浏览器不暴露),这里多读几次取稳定值。
  function snapshot() {
    const m = performance.memory;
    const turns = document.querySelectorAll('[data-testid^="conversation-turn"], [data-message-id]').length;
    const domEls = document.getElementsByTagName("*").length;
    const patched = window.__CLF_PATCHED__ === true;
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem("clf_config")); } catch (e) {}
    let extra = 0;
    try { const e = JSON.parse(localStorage.getItem("clf_extra_messages")); if (e) extra = e.extra || 0; } catch (e) {}
    return { m, turns, domEls, patched, cfg, extra };
  }

  const s = snapshot();
  console.log("─".repeat(52));
  log("内存与 DOM 快照");
  if (!s.m) {
    console.warn("  performance.memory 不可用(非 Chrome 或被禁)。请改用任务管理器读内存。");
  } else {
    console.log("  JS 堆 已用 usedJSHeapSize :", mb(s.m.usedJSHeapSize));
    console.log("  JS 堆 已分配 totalJSHeapSize:", mb(s.m.totalJSHeapSize));
    console.log("  JS 堆 上限 jsHeapSizeLimit :", mb(s.m.jsHeapSizeLimit));
  }
  console.log("  DOM 消息 turn 数 :", s.turns);
  console.log("  DOM 元素总数    :", s.domEls);
  console.log("  裁剪已启用(__CLF_PATCHED__):", s.patched);
  console.log("  当前生效配置 clf_config     :", s.cfg);
  console.log("  累积 extra                  :", s.extra);
  console.log("─".repeat(52));
  log("请记下上面数据 + Chrome 任务管理器里本标签页的内存占用量,A/B 两组都测。");
})();
