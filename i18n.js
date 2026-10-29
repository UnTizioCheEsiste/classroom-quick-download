// Shared translation helper (content script, popup, offscreen document).
// Messages live in _locales/<lang>/messages.json and use {0}, {1}… as
// placeholders, filled in here (simpler than Chrome's named placeholders).
function t(key, ...subs) {
  const msg = chrome.i18n.getMessage(key) || key;
  return msg.replace(/\{(\d+)\}/g, (_, i) => String(subs[i] ?? ""));
}
