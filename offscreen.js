// Offscreen document: fetches the files with the browser's Google session,
// packs them into a ZIP and hands the service worker a Blob URL to save.

const ZIP_CONCURRENCY = 3;
const blobUrls = new Map(); // jobId → Blob URL, revoked once the download is done

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

async function fetchFile(file, onBytes) {
  let res = await fetch(file.url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let type = res.headers.get("content-type") || "";
  if (/text\/html/i.test(type)) {
    // Large Drive files: "can't scan for viruses" page → follow "Download anyway" (drive.js).
    const confirmUrl = DRIVE_DOWNLOAD.test(file.url) ? driveConfirmUrl(await res.text(), res.url) : null;
    if (!confirmUrl) throw new Error(t("gotHtmlPage"));
    res = await fetch(confirmUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    type = res.headers.get("content-type") || "";
    if (/text\/html/i.test(type)) throw new Error(t("gotHtmlPage"));
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
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        results[i] = await fetchFile(files[i], progress);
      } catch (err) {
        failed.push({ name: files[i].name, error: String(err.message || err) });
      }
      done++;
      progress(true);
    }
  };
  await Promise.all(Array.from({ length: ZIP_CONCURRENCY }, worker));

  const ok = results.filter(Boolean);
  if (!ok.length) {
    return { ok: false, error: failed[0]?.error || t("noFilesDownloaded"), failed };
  }
  const blob = makeZip(uniquePaths(ok));
  const url = URL.createObjectURL(blob);
  blobUrls.set(jobId, url);
  return { ok: true, url, count: ok.length, failed, size: blob.size };
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
