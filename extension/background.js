/* background.js — service worker（MV3）
 * 仅在安装时写入默认设置。无网络、无遥测。
 */
(() => {
  "use strict";
  const KEY_SETTINGS = "clf_settings";
  const DEFAULTS = { enabled: true, keepTurns: 15, debug: false };

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      chrome.storage.local.get({ [KEY_SETTINGS]: null }, (data) => {
        if (!data[KEY_SETTINGS]) {
          chrome.storage.local.set({ [KEY_SETTINGS]: DEFAULTS });
        }
      });
    }
  });
})();
