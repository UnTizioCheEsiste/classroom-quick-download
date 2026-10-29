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
