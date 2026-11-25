// Offscreen document: fetches the files with the browser's Google session,
// packs them into a ZIP and hands the service worker a Blob URL to save.

// Google throttles each file's speed, so several at once go faster overall;
// much higher risks being temporarily blocked.
const ZIP_CONCURRENCY = 6;
const blobUrls = new Map(); // jobId → Blob URL, revoked once the download is done

// Large files stay out of the ZIP: the ZIP is built in memory (and is limited
// to 4 GB), while a normal download streams to disk in parallel.
const LARGE_FILE_BYTES = 100 * 1024 * 1024;
const SEPARATE_TYPES = new Set(["video", "audio"]);
const SEPARATE = Symbol("separate");

function isLarge(res) {
  const type = res.headers.get("content-type") || "";
  const size = Number(res.headers.get("content-length")) || 0;
  return /^(video|audio)\//i.test(type) || size > LARGE_FILE_BYTES;
}

const MIME_EXT = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function cleanName(s) {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 120) || "file";
}

function filenameFromHeader(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {}
  }
  const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  return plain ? (plain[1] || plain[2]).trim() : null;
}

function fallbackName(label, contentType) {
  const ext = MIME_EXT[contentType.split(";")[0].trim()];
  if (!ext || new RegExp(`\\.${ext}$`, "i").test(label)) return label;
  return `${label}.${ext}`;
}

/** Returns a ZIP entry, or SEPARATE when the file is too big for the ZIP. */
async function fetchFile(file, onBytes) {
  const ctrl = new AbortController();
  const res = await fetch(file.url, { credentials: "include", signal: ctrl.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (/text\/html/i.test(type)) {
    // Drive's "can't scan for viruses" page only appears for large files.
    if (DRIVE_DOWNLOAD.test(file.url) && driveConfirmUrl(await res.text(), res.url)) return SEPARATE;
    throw new Error(t("gotHtmlPage"));
  }
  if (isLarge(res)) {
    ctrl.abort(); // don't read the body: it will be a normal download
    return SEPARATE;
  }
  const name = filenameFromHeader(res.headers.get("content-disposition")) || fallbackName(file.name || "file", type);

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes();
  }
  const data = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    data.set(c, pos);
    pos += c.length;
  }
  return { name: cleanName(name), folder: file.folder ? cleanName(file.folder) : "", data };
}

/** Avoids two files with the same path in the ZIP: "x.pdf", "x (2).pdf"… */
function uniquePaths(entries) {
  const used = new Set();
  return entries.map((e) => {
    const base = e.folder ? `${e.folder}/${e.name}` : e.name;
    let path = base;
    for (let i = 2; used.has(path.toLowerCase()); i++) {
      path = base.replace(/(\.[^./]+)?$/, ` (${i})$1`);
    }
    used.add(path.toLowerCase());
    return { path, data: e.data };
  });
}

async function buildZip({ jobId, files, tabId }) {
  let done = 0;
  let lastPing = 0;
  // Progress messages also keep the service worker awake.
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPing < 1000) return;
    lastPing = now;
    chrome.runtime.sendMessage({ type: "zipProgress", tabId, done, total: files.length }).catch(() => {});
  };

  const results = new Array(files.length);
  const failed = [];
  const separate = []; // { url, name, folder } — queued as normal downloads by the service worker
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      try {
        const entry = SEPARATE_TYPES.has(file.type) ? SEPARATE : await fetchFile(file, progress);
        if (entry === SEPARATE) separate.push({ url: file.url, name: file.name, folder: file.folder || "" });
        else results[i] = entry;
      } catch (err) {
        failed.push({ name: file.name, error: String(err.message || err) });
      }
      done++;
      progress(true);
    }
  };
  await Promise.all(Array.from({ length: ZIP_CONCURRENCY }, worker));

  const ok = results.filter(Boolean);
  if (!ok.length) {
    if (separate.length) return { ok: true, url: null, count: 0, separate, failed };
    return { ok: false, error: failed[0]?.error || t("noFilesDownloaded"), failed };
  }
  const blob = makeZip(uniquePaths(ok));
  const url = URL.createObjectURL(blob);
  blobUrls.set(jobId, url);
  return { ok: true, url, count: ok.length, separate, failed, size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;

  if (msg.type === "buildZip") {
    buildZip(msg).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String(err.message || err), failed: [] })
    );
    return true;
  }

  if (msg.type === "revoke") {
    const url = blobUrls.get(msg.jobId);
    if (url) URL.revokeObjectURL(url);
    blobUrls.delete(msg.jobId);
    sendResponse({ ok: true });
  }
});
