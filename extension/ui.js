/* ui.js — isolated world，document_idle
 *
 * 当裁剪器隐藏了更早的轮次时，显示一个"加载更早的消息"控件。
 * 点击后按【会话 id】(/c/<id>) 记录扩大的 extra 预算并刷新页面，
 * 让 MAIN world 用更大预算重新裁剪。按会话 id 而非完整 URL 记录，
 * 因此刷新时 query/hash 漂移不会丢状态（对原扩展 URL bug 的修复）。
 */
(() => {
  "use strict";

  const BTN_ID = "clf-load-more";
  const KEY_EXTRA = "clf_extra_messages";
  const KEY_STATUS = "clf_last_status";
  const STEP = 20; // 每次"加载更早"扩大的轮次预算

  function convIdFromUrl(url) {
    const m = String(url).match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function currentExtra(convId) {
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

  function writeExtra(convId, extra) {
    if (!convId) return;
    try {
      localStorage.setItem(KEY_EXTRA, JSON.stringify({ convId, extra }));
    } catch (e) {
      /* 忽略 */
    }
  }

  function removeButton() {
    const b = document.getElementById(BTN_ID);
    if (b) b.remove();
  }

  function renderButton(status) {
    if (!status || !status.hasOlderMessages) {
      removeButton();
      return;
    }
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "加载更早的消息";
    Object.assign(btn.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483646",
      padding: "6px 14px",
      fontSize: "13px",
      fontWeight: "500",
      color: "#fff",
      background: "#10a37f",
      border: "none",
      borderRadius: "9999px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      cursor: "pointer",
    });
    btn.addEventListener("click", () => {
      const convId = convIdFromUrl(location.href);
      writeExtra(convId, currentExtra(convId) + STEP);
      location.reload();
    });
    document.body.appendChild(btn);
  }

  // 根据 bridge 持久化的最新状态渲染按钮。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY_STATUS]) {
      const status = changes[KEY_STATUS].newValue;
      const convId = convIdFromUrl(location.href);
      if (status && status.conversationId === convId) {
        renderButton(status);
      } else {
        removeButton();
      }
    }
  });

  // 初始读一次已有状态。
  try {
    chrome.storage.local.get({ [KEY_STATUS]: null }, (data) => {
      const status = data[KEY_STATUS];
      if (status && status.conversationId === convIdFromUrl(location.href)) {
        renderButton(status);
      }
    });
  } catch (e) {
    /* 忽略 */
  }

  // SPA 切换会话时清理按钮。
  let lastConvId = convIdFromUrl(location.href);
  setInterval(() => {
    const convId = convIdFromUrl(location.href);
    if (convId !== lastConvId) {
      lastConvId = convId;
      removeButton();
    }
  }, 1000);
})();
