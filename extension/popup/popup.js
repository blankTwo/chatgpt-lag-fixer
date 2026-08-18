/* popup.js — 弹窗设置界面（纯 JS，无构建） */
(() => {
  "use strict";

  const KEY_SETTINGS = "clf_settings";
  const KEY_STATUS = "clf_last_status";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  const enabledEl = document.getElementById("enabled");
  const keepTurnsEl = document.getElementById("keepTurns");
  const keepValueEl = document.getElementById("keepValue");
  const debugEl = document.getElementById("debug");

  const statusEl = document.getElementById("status");
  const statRenderedEl = document.getElementById("statRendered");
  const statTotalEl = document.getElementById("statTotal");
  const statNoteEl = document.getElementById("statNote");

  function normalize(raw) {
    if (!raw) return { ...DEFAULTS };
    const keep = Number.isFinite(raw.keepTurns) ? Math.max(1, Math.floor(raw.keepTurns)) : DEFAULTS.keepTurns;
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      keepTurns: keep,
      debug: raw.debug ?? DEFAULTS.debug,
    };
  }

  function render(settings) {
    enabledEl.checked = settings.enabled;
    keepTurnsEl.value = String(settings.keepTurns);
    keepValueEl.value = String(settings.keepTurns);
    debugEl.checked = settings.debug;
  }

  const reloadHintEl = document.getElementById("reloadHint");
  const reloadBtnEl = document.getElementById("reloadBtn");

  function save() {
    const settings = normalize({
      enabled: enabledEl.checked,
      keepTurns: Number(keepTurnsEl.value),
      debug: debugEl.checked,
    });
    chrome.storage.local.set({ [KEY_SETTINGS]: settings });
    // 改动通过 fetch 拦截生效，需在页面下次加载对话时才应用 —— 提示刷新。
    if (reloadHintEl) reloadHintEl.hidden = false;
  }

  if (reloadBtnEl) {
    reloadBtnEl.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id != null) {
          chrome.tabs.reload(tabs[0].id);
          window.close();
        }
      });
    });
  }

  function renderStatus(status) {
    if (!status) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statRenderedEl.textContent = String(status.visibleKept);
    statTotalEl.textContent = String(status.visibleTotal);
    statNoteEl.textContent = status.hasOlderMessages
      ? "已从渲染中裁剪 " + (status.visibleTotal - status.visibleKept) + " 个较旧的对话轮次。"
      : "当前对话无需裁剪。";
  }

  enabledEl.addEventListener("change", save);
  debugEl.addEventListener("change", save);
  keepTurnsEl.addEventListener("input", () => {
    keepValueEl.value = keepTurnsEl.value;
  });
  keepTurnsEl.addEventListener("change", save);

  chrome.storage.local.get({ [KEY_SETTINGS]: DEFAULTS, [KEY_STATUS]: null }, (data) => {
    render(normalize(data[KEY_SETTINGS]));
    renderStatus(data[KEY_STATUS]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY_STATUS]) {
      renderStatus(changes[KEY_STATUS].newValue);
    }
  });
})();
