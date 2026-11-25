// Receives requests from the content script and starts downloads with the
// chrome.downloads API. The browser's Google session cookies are included, so
// private course files work too.

importScripts("i18n.js", "drive.js");

// URL → subfolder to save the file in (multiple downloads only).
const pendingFolders = new Map();
// URL → full path. Needed for the ZIP: while an onDeterminingFilename listener
// is registered, Chrome/Brave ignore the filename passed to downloads.download()
// and a Blob URL would be saved under a random name.
const pendingNames = new Map();

// Pause between downloads, so Google doesn't rate-limit us.
const DOWNLOAD_GAP_MS = 350;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const fullName = pendingNames.get(item.url);
  if (fullName) {
    pendingNames.delete(item.url);
    return suggest({ filename: fullName, conflictAction: "uniquify" });
  }
  const folder = pendingFolders.get(item.url);
  if (!folder) return suggest();
  pendingFolders.delete(item.url);
  const name = item.filename.split(/[\\/]/).pop();
  suggest({ filename: `${folder}/${name}`, conflictAction: "uniquify" });
});

/** items: [{ url, folder }] — folder is a path relative to the Downloads folder. */
async function downloadMany(items) {
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    const url = await bypassDriveWarning(item.url);
    if (item.folder) pendingFolders.set(url, item.folder);
    try {
      await chrome.downloads.download({ url });
      ok++;
    } catch (err) {
      console.warn("[Classroom Quick Download]", url, err);
      pendingFolders.delete(url);
      failed++;
    }
    await new Promise((r) => setTimeout(r, DOWNLOAD_GAP_MS));
  }
  return { ok: failed === 0, started: ok, failed };
}

// --- ZIP -------------------------------------------------------------------
// A service worker can't create Blob URLs: the files are fetched and packed in
// an offscreen document, then a single ZIP is saved.

let zipBusy = false;

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: t("offscreenJustification"),
    });
  } catch (err) {
    // Already exists: that's fine.
    if (!/single offscreen|already/i.test(String(err.message))) throw err;
  }
}

async function downloadZip(files, filename, tabId) {
  if (zipBusy) return { ok: false, error: t("zipBusy") };
  zipBusy = true;
  try {
    await ensureOffscreen();
    const jobId = crypto.randomUUID();
    const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "buildZip", jobId, files, tabId });
    if (!res?.ok) {
      return { ok: false, error: res?.error || t("zipFailed"), failedNames: (res?.failed || []).map((f) => f.name) };
    }
    const zipName = filename || "Classroom - posts.zip";
    pendingNames.set(res.url, zipName);
    const downloadId = await chrome.downloads.download({ url: res.url, filename: zipName, conflictAction: "uniquify" });
    // Kept in storage: the service worker may go to sleep while you pick where to save.
    await chrome.storage.session.set({ [`zip:${downloadId}`]: jobId });
    return {
      ok: true,
      zip: true,
      started: res.count,
      failed: res.failed.length,
      failedNames: res.failed.map((f) => f.name),
    };
  } finally {
    zipBusy = false;
  }
}

// Once the ZIP is saved (or cancelled), free the offscreen document's memory.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const key = `zip:${delta.id}`;
  const { [key]: jobId } = await chrome.storage.session.get(key);
  if (!jobId) return;
  await chrome.storage.session.remove(key);
  await chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", jobId }).catch(() => {});
  const rest = await chrome.storage.session.get(null);
  if (!Object.keys(rest).some((k) => k.startsWith("zip:"))) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ZIP progress: from the offscreen document to the Classroom tab.
  if (msg?.type === "zipProgress" && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, msg, { frameId: 0 }).catch(() => {});
    return;
  }

  if (msg?.type === "downloadZip" && Array.isArray(msg.files)) {
    downloadZip(msg.files, msg.filename, sender.tab?.id).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String(err.message || err) })
    );
    return true;
  }

  if (msg?.type === "download" && typeof msg.url === "string") {
    bypassDriveWarning(msg.url)
      .then((url) => chrome.downloads.download({ url }))
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (msg?.type === "downloadMany" && Array.isArray(msg.items)) {
    downloadMany(msg.items).then(sendResponse);
    return true;
  }
});
