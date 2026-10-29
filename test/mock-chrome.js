// Fake extension environment, to try content.js outside Chrome.
// window.__downloads collects the messages that would go to the background.
// URL options: ?lang=it for Italian, and any setting, e.g. ?zip=false&postFolders=false
(() => {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang") || "en";
  const xhr = new XMLHttpRequest();
  xhr.open("GET", `/_locales/${lang}/messages.json`, false); // sync: fine for a test page
  xhr.send();
  const messages = JSON.parse(xhr.responseText);

  window.__downloads = [];
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage(msg, cb) {
        window.__downloads.push(msg);
        setTimeout(() => cb({ ok: true, started: (msg.urls || msg.items || msg.files || [1]).length, failed: 0, zip: msg.type === "downloadZip" }), 50);
      },
      onMessage: { addListener(fn) { window.__onMessage = fn; } },
    },
    i18n: {
      getMessage: (key) => messages[key]?.message ?? "",
      getUILanguage: () => lang,
    },
    storage: {
      sync: {
        get: async (d) => {
          const out = { ...d };
          for (const [k, v] of params) if (k in d) out[k] = v === "true" ? true : v === "false" ? false : v;
          return out;
        },
        set: async () => {},
      },
      onChanged: { addListener() {} },
    },
  };
})();
