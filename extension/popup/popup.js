/* popup.js — 弹窗设置界面（纯 JS，无构建） */
(() => {
  "use strict";

  const KEY_SETTINGS = "clf_settings";
  const KEY_STATUS = "clf_last_status";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  const enabledEl = document.getElementById("enabled");
  const keepTurnsEl = document.getElementById("keepTurns");
  const keepValueEl = document.getElementById("keepValue");
  const keepValueTextEl = document.getElementById("keepValueText");
  const debugEl = document.getElementById("debug");

  const statusEl = document.getElementById("status");
  const statRenderedEl = document.getElementById("statRendered");
  const statTotalEl = document.getElementById("statTotal");
  const statHealthEl = document.getElementById("statHealth");
  const statNoteEl = document.getElementById("statNote");
  const reloadHintEl = document.getElementById("reloadHint");
  const reloadBtnEl = document.getElementById("reloadBtn");

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const keep = Number.isFinite(raw.keepTurns)
      ? Math.max(1, Math.floor(raw.keepTurns))
      : DEFAULTS.keepTurns;
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      keepTurns: keep,
      debug: raw.debug ?? DEFAULTS.debug,
    };
  }

  function updateSliderProgress() {
    const min = Number(keepTurnsEl.min) || 0;
    const max = Number(keepTurnsEl.max) || 100;
    const value = Number(keepTurnsEl.value) || min;
    const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
    keepTurnsEl.style.setProperty("--range-progress", progress + "%");
  }

  function syncKeepValue(value) {
    const text = String(value);
    keepValueEl.value = text;
    if (keepValueTextEl) keepValueTextEl.textContent = text;
  }

  function render(settings) {
    enabledEl.checked = settings.enabled;
    keepTurnsEl.value = String(settings.keepTurns);
    syncKeepValue(settings.keepTurns);
    debugEl.checked = settings.debug;
    updateSliderProgress();
  }

  function markDirty() {
    if (!reloadHintEl) return;
    reloadHintEl.textContent = "设置已修改，刷新后生效";
    reloadHintEl.classList.add("is-dirty");
  }

  function markClean() {
    if (!reloadHintEl) return;
    reloadHintEl.textContent = "当前设置已生效";
    reloadHintEl.classList.remove("is-dirty");
  }

  function save() {
    const settings = normalize({
      enabled: enabledEl.checked,
      keepTurns: Number(keepTurnsEl.value),
      debug: debugEl.checked,
    });
    chrome.storage.local.set({ [KEY_SETTINGS]: settings });
    markDirty();
  }

  function renderStatus(status) {
    statusEl.hidden = false;

    if (!status) {
      statRenderedEl.textContent = "–";
      statTotalEl.textContent = "–";
      if (statHealthEl) statHealthEl.textContent = "等待";
      statNoteEl.textContent = "打开或刷新 ChatGPT 会话后显示优化状态。";
      return;
    }

    const kept = Number(status.visibleKept);
    const total = Number(status.visibleTotal);
    const rendered = Number.isFinite(kept) ? kept : null;
    const original = Number.isFinite(total) ? total : null;
    const trimmed = rendered != null && original != null ? Math.max(0, original - rendered) : null;

    statRenderedEl.textContent = rendered == null ? "–" : String(rendered);
    statTotalEl.textContent = trimmed == null ? "–" : String(trimmed);
    if (statHealthEl) statHealthEl.textContent = "良好";

    if (status.detail?.rolling) {
      if (status.detail.action === "reload-blocked") {
        statNoteEl.textContent = "已达到运行期缓冲上限，当前处于安全刷新保护期。";
      } else {
        statNoteEl.textContent = "运行期缓冲已到上限，将安全刷新并恢复设定窗口。";
      }
      return;
    }

    statNoteEl.textContent = status.hasOlderMessages
      ? "裁剪后保持最近对话窗口，可继续正常提问。"
      : "当前对话无需裁剪，运行状态正常。";
  }

  enabledEl.addEventListener("change", save);
  debugEl.addEventListener("change", save);
  keepTurnsEl.addEventListener("input", () => {
    syncKeepValue(keepTurnsEl.value);
    updateSliderProgress();
  });
  keepTurnsEl.addEventListener("change", save);

  if (reloadBtnEl) {
    reloadBtnEl.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.id != null) {
          chrome.tabs.reload(tabs[0].id);
          markClean();
          window.close();
        }
      });
    });
  }

  chrome.storage.local.get({ [KEY_SETTINGS]: DEFAULTS, [KEY_STATUS]: null }, (data) => {
    render(normalize(data[KEY_SETTINGS]));
    renderStatus(data[KEY_STATUS]);
    markClean();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY_STATUS]) {
      renderStatus(changes[KEY_STATUS].newValue);
    }
  });
})();
