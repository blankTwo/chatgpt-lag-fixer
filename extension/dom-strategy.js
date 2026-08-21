/* dom-strategy.js — 运行期安全窗口守卫（重建版）
 *
 * 只保留 0.2.4 风格的“安全刷新收窗”：
 *   - 不删除 React 管理的 DOM；
 *   - 不处理 iframe；
 *   - 不注入 content-visibility / contain；
 *   - 首屏历史加载阶段不自动刷新；
 *   - 只有用户真正发送消息，并观察到新 turn / streaming 后才激活；
 *   - 达到 keepTurns + extra + 5，且 streaming 结束、DOM 稳定、无草稿时刷新。
 */
(() => {
  "use strict";

  const KEY_SETTINGS = "clf_settings";
  const KEY_STATUS = "clf_last_status";
  const KEY_EXTRA = "clf_extra_messages";
  const KEY_RELOAD_AT = "clf_runtime_reload_at";
  const KEY_RESTORE_BOTTOM = "clf_restore_bottom";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  const TURN = '[data-testid^="conversation-turn-"]';
  const FALLBACK = "[data-message-author-role]";
  const ANY_TURN = `${TURN},${FALLBACK}`;
  const STREAMING = '[data-is-streaming="true"],.result-streaming';
  const BUFFER_TURNS = 5;
  const STABLE_MS = 1200;
  const RETRY_MS = 250;
  const RELOAD_GUARD_MS = 15000;
  const SEND_INTENT_TTL_MS = 10000;

  let engine = null;
  let enabled = true;
  let keepTurns = DEFAULTS.keepTurns;
  let debug = DEFAULTS.debug;
  let extensionContextAlive = true;
  let lastStatus = "";

  function dlog(...args) {
    if (debug) console.log("[CLF Runtime]", ...args);
  }

  function isContextInvalidated(error) {
    return String(error?.message || error || "").includes("Extension context invalidated");
  }

  function handleExtensionApiError(error) {
    if (isContextInvalidated(error)) {
      if (extensionContextAlive) {
        extensionContextAlive = false;
        stop();
      }
      return;
    }
    console.warn("[CLF] 扩展 API 调用失败:", error);
  }

  function safeStorageSet(items) {
    if (!extensionContextAlive) return false;
    try {
      chrome.storage.local.set(items);
      return true;
    } catch (error) {
      handleExtensionApiError(error);
      return false;
    }
  }

  function safeStorageRemove(key) {
    if (!extensionContextAlive) return false;
    try {
      chrome.storage.local.remove(key);
      return true;
    } catch (error) {
      handleExtensionApiError(error);
      return false;
    }
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      keepTurns: Number.isFinite(raw.keepTurns)
        ? Math.max(1, Math.floor(raw.keepTurns))
        : DEFAULTS.keepTurns,
      debug: raw.debug ?? DEFAULTS.debug,
    };
  }

  function turns() {
    const primary = Array.from(document.querySelectorAll(TURN));
    return primary.length ? primary : Array.from(document.querySelectorAll(FALLBACK));
  }

  function containsTurn(node) {
    return node instanceof Element &&
      (node.matches(ANY_TURN) || Boolean(node.querySelector(ANY_TURN)));
  }

  function containingTurn(node) {
    return node instanceof Element ? node.closest(TURN) || node.closest(FALLBACK) : null;
  }

  function streaming(node) {
    return node instanceof Element &&
      (node.matches(STREAMING) || Boolean(node.querySelector(STREAMING)));
  }

  function conversationId() {
    const m = String(location.href).match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function extraBudget() {
    const convId = conversationId();
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

  function composerElement() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid*="composer"]') ||
      document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function composerHasDraft() {
    const el = composerElement();
    if (!el) return false;
    const value = "value" in el ? el.value : el.textContent;
    return Boolean(String(value || "").trim());
  }

  function isSendButton(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(
      'button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="发送"]'
    ));
  }

  function report(kept, total, action) {
    const payload = {
      conversationId: conversationId(),
      visibleKept: kept,
      visibleTotal: total,
      absoluteMessageCount: total,
      hasOlderMessages: total > kept,
      detail: {
        rolling: true,
        bufferTurns: BUFFER_TURNS,
        action,
      },
    };
    const signature = JSON.stringify(payload);
    if (signature === lastStatus) return true;
    if (!safeStorageSet({ [KEY_STATUS]: payload })) return false;
    lastStatus = signature;
    return true;
  }

  function recentReloadBlocked() {
    try {
      const at = Number(sessionStorage.getItem(KEY_RELOAD_AT) || 0);
      return at > 0 && Date.now() - at < RELOAD_GUARD_MS;
    } catch (_) {
      return false;
    }
  }

  function markReload() {
    try {
      sessionStorage.setItem(KEY_RELOAD_AT, String(Date.now()));
      sessionStorage.setItem(KEY_RESTORE_BOTTOM, "1");
    } catch (_) {
      /* 忽略 */
    }
  }

  function clearExtraBudget() {
    try {
      localStorage.removeItem(KEY_EXTRA);
    } catch (_) {
      /* 忽略 */
    }
  }

  function restoreBottomAfterReload() {
    let shouldRestore = false;
    try {
      shouldRestore = sessionStorage.getItem(KEY_RESTORE_BOTTOM) === "1";
      if (shouldRestore) sessionStorage.removeItem(KEY_RESTORE_BOTTOM);
    } catch (_) {
      /* 忽略 */
    }
    if (!shouldRestore) return;

    const scrollLast = () => {
      const list = turns();
      list[list.length - 1]?.scrollIntoView?.({ block: "end" });
    };
    setTimeout(scrollLast, 350);
    setTimeout(scrollLast, 1200);
  }

  class TrimWindowGuard {
    constructor(windowSize) {
      this.windowSize = Math.max(1, Number(windowSize) || DEFAULTS.keepTurns);
      this.observer = null;
      this.frame = null;
      this.timer = null;
      this.nodes = [];
      this.dirty = true;
      this.lastActivityAt = performance.now();
      this.pendingSendAt = 0;
      this.baselineAtSend = 0;
      this.runtimeArmed = false;

      this.onKeyDown = (event) => {
        const composer = composerElement();
        if (!composer || !(event.target instanceof Node) || !composer.contains(event.target)) return;
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        this.noteSendIntent("Enter");
      };
      this.onClick = (event) => {
        if (isSendButton(event.target)) this.noteSendIntent("发送按钮");
      };
      this.onSubmit = (event) => {
        const composer = composerElement();
        if (!composer || !(event.target instanceof Element)) return;
        if (event.target.contains(composer)) this.noteSendIntent("submit");
      };
    }

    noteSendIntent(source) {
      this.pendingSendAt = performance.now();
      this.baselineAtSend = turns().length;
      dlog("检测到发送意图 →", source, "| baseline turns:", this.baselineAtSend);
    }

    start() {
      if (!document.body) return;
      this.observer = new MutationObserver((mutations) => {
        let changed = false;
        for (const mutation of mutations) {
          if (mutation.type === "attributes") {
            if (containingTurn(mutation.target)) changed = true;
          } else {
            for (const node of mutation.addedNodes) {
              if (containsTurn(node)) {
                this.dirty = true;
                changed = true;
                break;
              }
            }
            if (!changed) {
              for (const node of mutation.removedNodes) {
                if (containsTurn(node)) {
                  this.dirty = true;
                  changed = true;
                  break;
                }
              }
            }
          }
        }
        if (changed) {
          this.lastActivityAt = performance.now();
          this.schedule();
        }
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-is-streaming"],
      });

      document.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("click", this.onClick, true);
      document.addEventListener("submit", this.onSubmit, true);
      restoreBottomAfterReload();
      this.update();
    }

    stop() {
      this.observer?.disconnect();
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      if (this.timer !== null) clearTimeout(this.timer);
      document.removeEventListener("keydown", this.onKeyDown, true);
      document.removeEventListener("click", this.onClick, true);
      document.removeEventListener("submit", this.onSubmit, true);
      this.observer = null;
      this.frame = null;
      this.timer = null;
    }

    schedule() {
      if (this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.update();
      });
    }

    scheduleCheck(delay) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, Math.max(RETRY_MS, delay));
    }

    refreshNodes() {
      if (!this.dirty) return;
      this.nodes = turns();
      this.dirty = false;
    }

    maybeArm() {
      if (this.runtimeArmed || !this.pendingSendAt) return;
      const age = performance.now() - this.pendingSendAt;
      if (age > SEND_INTENT_TTL_MS) {
        this.pendingSendAt = 0;
        return;
      }
      const hasStreaming = this.nodes.some((node) => streaming(node));
      const hasNewTurn = this.nodes.length > this.baselineAtSend;
      if (!hasStreaming && !hasNewTurn) return;

      this.runtimeArmed = true;
      this.pendingSendAt = 0;
      dlog("运行期窗口已激活 → 已观察到新 turn/streaming");
    }

    update() {
      this.refreshNodes();
      this.maybeArm();

      if (!this.runtimeArmed) return;

      const extra = extraBudget();
      const budget = this.windowSize + extra;
      const softLimit = budget + BUFFER_TURNS;

      if (this.nodes.length < softLimit) return;

      if (this.nodes.some((node) => streaming(node))) {
        this.lastActivityAt = performance.now();
        this.scheduleCheck(RETRY_MS);
        return;
      }

      const stableFor = performance.now() - this.lastActivityAt;
      if (stableFor < STABLE_MS) {
        this.scheduleCheck(STABLE_MS - stableFor);
        return;
      }

      if (composerHasDraft()) {
        this.scheduleCheck(RETRY_MS);
        return;
      }

      if (recentReloadBlocked()) {
        report(budget, this.nodes.length, "reload-blocked");
        this.scheduleCheck(RELOAD_GUARD_MS);
        return;
      }

      if (!report(budget, this.nodes.length, "reload")) return;

      dlog(
        "自动刷新收窗 →",
        "当前 turns:", this.nodes.length,
        "| keepTurns:", this.windowSize,
        "| extra:", extra,
        "| softLimit:", softLimit,
      );
      clearExtraBudget();
      markReload();
      location.reload();
    }
  }

  function stop() {
    engine?.stop();
    engine = null;
  }

  function clearStatus() {
    lastStatus = "";
    safeStorageRemove(KEY_STATUS);
  }

  function apply(raw) {
    const settings = normalize(raw);
    if (
      settings.enabled === enabled &&
      settings.keepTurns === keepTurns &&
      settings.debug === debug &&
      engine
    ) return;

    stop();
    enabled = settings.enabled;
    keepTurns = settings.keepTurns;
    debug = settings.debug;

    if (!enabled) {
      clearStatus();
      return;
    }

    engine = new TrimWindowGuard(keepTurns);
    engine.start();
    dlog(
      "窗口守卫启动 →",
      "keepTurns:", keepTurns,
      "| buffer:", BUFFER_TURNS,
      "| softLimit:", keepTurns + BUFFER_TURNS,
      "| 当前 turns:", turns().length,
      "| runtime armed:", false,
    );
  }

  try {
    chrome.storage.local.get({ [KEY_SETTINGS]: DEFAULTS }, (data) => apply(data[KEY_SETTINGS]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY_SETTINGS]) apply(changes[KEY_SETTINGS].newValue);
    });
  } catch (error) {
    handleExtensionApiError(error);
  }
})();
