const DEFAULTS = {
  docFormat: "pdf",
  slidesFormat: "pdf",
  sheetsFormat: "xlsx",
  courseFolder: true,
  postFolders: true,
  zip: true,
};

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");

// Settings
chrome.storage.sync.get(DEFAULTS).then((settings) => {
  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    if (el.type === "checkbox") el.checked = settings[key];
    else el.value = settings[key];
    el.addEventListener("change", () => {
      chrome.storage.sync.set({ [key]: el.type === "checkbox" ? el.checked : el.value });
    });
  }
});

// State of the active tab
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await activeTab();
  let status;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
  } catch {
    statusEl.textContent = t("popupOpenClassroom");
    return;
  }

  if (!status.posts) {
    statusEl.textContent = t("popupNothing");
    return;
  }

  const parts = [t("popupPostsFound", status.posts)];
  if (status.files) parts.push(t("popupFilesVisible", status.files));
  if (status.closed) parts.push(t("popupClosedPosts", status.closed));
  statusEl.textContent = `${parts.join(" · ")}.`;
  toggleBtn.hidden = false;
  toggleBtn.textContent = status.selectionActive ? t("popupExitSelection") : t("popupSelectionMode");
  toggleBtn.addEventListener("click", async () => {
    await chrome.tabs.sendMessage(tab.id, { type: "toggleSelection" });
    window.close();
  });
}

init();

// Background download queue
const queueEl = document.getElementById("queue");
const queueAction = document.getElementById("queueAction");

function formatBytes(n) {
  if (!n) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
}

async function showQueue() {
  const s = await chrome.runtime.sendMessage({ type: "queueStatus" }).catch(() => null);
  if (!s?.total) return;
  const running = s.active.length + s.pending;
  queueEl.hidden = false;
  document.getElementById("queueTitle").textContent = s.cancelled
    ? t("queueCancelled")
    : running
      ? t("queueTitle", s.done, s.total)
      : t("queueFinished", s.done, s.total);
  const finished = s.done + s.failed.length;
  document.getElementById("queueFill").style.width = `${Math.round((finished / s.total) * 100)}%`;
  const meta = [];
  if (s.active.length) meta.push(t("queueActive", s.active.length));
  if (s.pending) meta.push(t("queuePending", s.pending));
  meta.push(t("queueBytes", formatBytes(s.bytes)));
  if (s.failed.length) meta.push(t("queueFailedShort", s.failed.length));
  document.getElementById("queueMeta").textContent = meta.join(" · ");
  queueAction.hidden = !running && !s.canShow;
  queueAction.textContent = running ? t("queueCancel") : t("queueShowFolder");
  queueAction.dataset.action = running ? "cancel" : "show";
}

queueAction.addEventListener("click", async () => {
  const type = queueAction.dataset.action === "cancel" ? "queueCancel" : "queueShowFolder";
  await chrome.runtime.sendMessage({ type });
  showQueue();
});

showQueue();
setInterval(showQueue, 1000);
