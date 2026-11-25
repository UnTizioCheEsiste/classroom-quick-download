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

// --- Download queue ----------------------------------------------------------
// Bulk downloads go through a queue: a few at a time instead of all at once
// (dozens of parallel videos all crawl). The state lives in storage.session
// because the service worker sleeps between events; download events wake it.

const QUEUE_CONCURRENCY = 5;
const QUEUE_KEY = "queue";

const emptyQueue = () => ({
  pending: [], // [{ url, folder, name }] waiting for a slot
  active: {}, // downloadId → item
  total: 0,
  done: 0,
  failed: [], // names
  bytesDone: 0,
  lastDoneId: null, // to open the folder at the end
  cancelled: false,
});

const remaining = (q) => q.pending.length + Object.keys(q.active).length;

// Queue operations run one after the other: read state, change it, save it.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(async () => {
    const { [QUEUE_KEY]: q = emptyQueue() } = await chrome.storage.session.get(QUEUE_KEY);
    const result = await fn(q);
    await chrome.storage.session.set({ [QUEUE_KEY]: q });
    const n = remaining(q);
    chrome.action.setBadgeBackgroundColor({ color: "#1e8e3e" });
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    return result;
  });
  queueLock = run.catch(() => {});
  return run;
}

/** Starts queued downloads until QUEUE_CONCURRENCY are running. */
async function fillSlots(q) {
  while (Object.keys(q.active).length < QUEUE_CONCURRENCY && q.pending.length) {
    const item = q.pending.shift();
    const url = await bypassDriveWarning(item.url);
    if (item.folder) pendingFolders.set(url, item.folder);
    try {
      const id = await chrome.downloads.download({ url });
      q.active[id] = item;
    } catch (err) {
      console.warn("[Classroom Quick Download]", url, err);
      pendingFolders.delete(url);
      q.failed.push(item.name || item.url);
    }
  }
}

/** items: [{ url, folder, name }] — folder is a path relative to the Downloads folder. */
function enqueue(items) {
  return withQueue(async (q) => {
    if (!remaining(q)) Object.assign(q, emptyQueue()); // previous batch finished: start fresh
    q.pending.push(...items);
    q.total += items.length;
    await fillSlots(q);
    return { ok: true, queued: items.length };
  });
}

function queueStatus() {
  return withQueue(async (q) => {
    const ids = Object.keys(q.active).map(Number);
    const found = (await Promise.all(ids.map((id) => chrome.downloads.search({ id })))).flat();
    let bytes = q.bytesDone;
    const active = found.map((d) => {
      bytes += d.bytesReceived;
      return { name: d.filename.split(/[\\/]/).pop() || q.active[d.id]?.name, received: d.bytesReceived, total: d.totalBytes };
    });
    return {
      total: q.total,
      done: q.done,
      failed: q.failed,
      pending: q.pending.length,
      active,
      bytes,
      cancelled: q.cancelled,
      canShow: q.lastDoneId != null,
    };
  });
}

function cancelQueue() {
  return withQueue(async (q) => {
    const ids = Object.keys(q.active).map(Number);
    q.pending = [];
    q.active = {}; // their "interrupted" events will be ignored
    q.cancelled = true;
    await Promise.all(ids.map((id) => chrome.downloads.cancel(id).catch(() => {})));
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  onZipSaved(delta.id);
  withQueue(async (q) => {
    const item = q.active[delta.id];
    if (!item) return;
    delete q.active[delta.id];
    if (state === "complete") {
      q.done++;
      q.lastDoneId = delta.id;
      const [d] = await chrome.downloads.search({ id: delta.id });
      q.bytesDone += d?.fileSize || d?.bytesReceived || 0;
    } else {
      q.failed.push(item.name || item.url);
    }
    await fillSlots(q);
  });
});

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

/**
 * files: [{ url, name, folder, type }]; folder is the post subfolder inside the ZIP.
 * baseFolder: where in Downloads the ZIP goes — large files kept out of the ZIP
 * are saved there too, in the same post subfolders.
 */
async function downloadZip(files, filename, baseFolder, tabId) {
  if (zipBusy) return { ok: false, error: t("zipBusy") };
  zipBusy = true;
  try {
    await ensureOffscreen();
    const jobId = crypto.randomUUID();
    const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "buildZip", jobId, files, tabId });
    if (!res?.ok) {
      return { ok: false, error: res?.error || t("zipFailed"), failedNames: (res?.failed || []).map((f) => f.name) };
    }

    // Videos and large files: queued as normal downloads, streamed to disk.
    const separate = res.separate || [];
    if (separate.length) {
      await enqueue(
        separate.map((f) => ({ url: f.url, name: f.name, folder: [baseFolder, f.folder].filter(Boolean).join("/") }))
      );
    }

    if (res.url) {
      const zipName = filename || "Classroom - posts.zip";
      pendingNames.set(res.url, zipName);
      const downloadId = await chrome.downloads.download({ url: res.url, filename: zipName, conflictAction: "uniquify" });
      // Kept in storage: the service worker may go to sleep while you pick where to save.
      await chrome.storage.session.set({ [`zip:${downloadId}`]: jobId });
    }
    return {
      ok: true,
      zip: !!res.url,
      started: res.count,
      separate: separate.length,
      failed: res.failed.length,
      failedNames: res.failed.map((f) => f.name),
    };
  } finally {
    zipBusy = false;
  }
}

// Once the ZIP is saved (or cancelled), free the offscreen document's memory.
async function onZipSaved(downloadId) {
  const key = `zip:${downloadId}`;
  const { [key]: jobId } = await chrome.storage.session.get(key);
  if (!jobId) return;
  await chrome.storage.session.remove(key);
  await chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", jobId }).catch(() => {});
  const rest = await chrome.storage.session.get(null);
  if (!Object.keys(rest).some((k) => k.startsWith("zip:"))) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ZIP progress: from the offscreen document to the Classroom tab.
  if (msg?.type === "zipProgress" && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, msg, { frameId: 0 }).catch(() => {});
    return;
  }

  const reply = (promise) => {
    promise.then(sendResponse, (err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // async response
  };

  if (msg?.type === "downloadZip" && Array.isArray(msg.files)) {
    return reply(downloadZip(msg.files, msg.filename, msg.baseFolder || "", sender.tab?.id));
  }
  if (msg?.type === "download" && typeof msg.url === "string") {
    return reply(
      bypassDriveWarning(msg.url)
        .then((url) => chrome.downloads.download({ url }))
        .then((downloadId) => ({ ok: true, downloadId }))
    );
  }
  if (msg?.type === "downloadMany" && Array.isArray(msg.items)) return reply(enqueue(msg.items));
  if (msg?.type === "queueStatus") return reply(queueStatus());
  if (msg?.type === "queueCancel") return reply(cancelQueue().then(() => ({ ok: true })));
  if (msg?.type === "queueShowFolder") {
    return reply(
      withQueue(async (q) => {
        if (q.lastDoneId != null) chrome.downloads.show(q.lastDoneId);
        return { ok: true };
      })
    );
  }
});
