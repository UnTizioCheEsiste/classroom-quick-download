// Classroom Quick Download — content script
// - Adds a small download icon next to every attachment (Drive, Docs, Slides, Sheets).
// - Adds "Download all" on assignment / material / announcement pages.
// - Selection mode (started from the popup): a checkbox on every post, filters by
//   type and name, and bulk download as a single ZIP or separate files.
// Text comes from t() in i18n.js (loaded before this file).

(() => {
  // Lets you check from the console which version is running in the page.
  document.documentElement.dataset.cqdVersion = chrome.runtime.getManifest().version;

  const BTN_CLASS = "cqd-btn";
  // Everything we insert into the page has this class, so we can ignore it
  // when analysing Classroom's DOM.
  const UI_CLASS = "cqd-ui";

  const ICONS = {
    download:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    done:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  const DEFAULTS = {
    docFormat: "pdf",
    slidesFormat: "pdf",
    sheetsFormat: "xlsx",
    courseFolder: true, // Downloads/Classroom/<course>/…
    postFolders: true, // one subfolder per post
    zip: true,
  };
  let settings = { ...DEFAULTS };

  // File types, in the order the filter chips are shown.
  const TYPES = [
    "pdf", "gdoc", "gslides", "gsheet", "gdraw", "word", "powerpoint",
    "excel", "image", "video", "audio", "archive", "other",
  ];
  const typeLabel = (type) => t(`type${type[0].toUpperCase()}${type.slice(1)}`);

  // [type, extension in the file name, word on the attachment card (EN/IT)]
  const TYPE_RULES = [
    ["pdf", /\.pdf\b/i, /\bpdf\b/i],
    ["word", /\.(docx?|odt|rtf)\b/i, /\bword\b/i],
    ["powerpoint", /\.(pptx?|ppsx?|odp)\b/i, /\bpowerpoint\b/i],
    ["excel", /\.(xlsx?|ods|csv)\b/i, /\bexcel\b/i],
    ["image", /\.(png|jpe?g|gif|webp|heic|bmp|svg|tiff?)\b/i, /\b(immagine|image)\b/i],
    ["video", /\.(mp4|mov|avi|mkv|webm|m4v)\b/i, /\bvideo\b/i],
    ["audio", /\.(mp3|wav|m4a|ogg|flac|aac)\b/i, /\baudio\b/i],
    ["archive", /\.(zip|rar|7z|tar|gz|tgz)\b/i, /\b(zip|archivio|archive)\b/i],
  ];

  const LINK_SELECTOR =
    'a[href*="drive.google.com"], a[href*="docs.google.com"], a[href*="google.com/url"]';

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const normalize = (s) => s.replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------------------
  // Link → download URL
  // ---------------------------------------------------------------------------

  /** Index of the active Google account (e.g. /u/1/ in the Classroom URL). */
  function currentAuthUser(linkUrl) {
    const fromLink = linkUrl.searchParams.get("authuser");
    if (fromLink) return fromLink;
    const m = location.pathname.match(/\/u\/(\d+)\//);
    return m ? m[1] : null;
  }

  /** Turns a Classroom link into { url, type? } to download, or null. */
  function resolve(href) {
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }

    // Classroom sometimes wraps links in a google.com/url?q=... redirect.
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      const target = url.searchParams.get("q") || url.searchParams.get("url");
      return target ? resolve(target) : null;
    }

    const authuser = currentAuthUser(url);
    const build = (base, params) => {
      const out = new URL(base);
      for (const [k, v] of Object.entries(params)) out.searchParams.set(k, v);
      if (authuser) out.searchParams.set("authuser", authuser);
      return out.href;
    };

    // Docs / Slides / Sheets / Drawings are not files: they have to be exported.
    if (url.hostname === "docs.google.com") {
      const m = url.pathname.match(/\/(document|presentation|spreadsheets|drawings)\/d\/([\w-]+)/);
      if (!m) return null;
      const [, kind, id] = m;
      const base = `https://docs.google.com/${kind}/d/${id}`;
      switch (kind) {
        case "document":
          return { type: "gdoc", url: build(`${base}/export`, { format: settings.docFormat }) };
        case "presentation":
          return { type: "gslides", url: build(`${base}/export`, { format: settings.slidesFormat }) };
        case "spreadsheets":
          return { type: "gsheet", url: build(`${base}/export`, { format: settings.sheetsFormat }) };
        case "drawings":
          return { type: "gdraw", url: build(`${base}/export/pdf`, {}) };
      }
    }

    // Files on Drive (PDF, zip, images, Office, …)
    if (url.hostname === "drive.google.com") {
      if (url.pathname.includes("/folders/")) return null; // folders can't be downloaded
      const m = url.pathname.match(/\/file\/d\/([\w-]+)/);
      const id = m ? m[1] : url.searchParams.get("id");
      if (!id) return null;
      // confirm=t skips the "can't scan this file for viruses" page Drive
      // shows for large files.
      return {
        url: build("https://drive.usercontent.google.com/download", {
          id,
          export: "download",
          confirm: "t",
        }),
      };
    }

    return null;
  }

  /**
   * Text of the attachment card: the link plus the surrounding elements that
   * contain no other links (that's where Classroom writes the type, e.g. "PDF").
   */
  function cardText(a) {
    let el = a;
    for (let i = 0; i < 4 && el.parentElement; i++) {
      const parent = el.parentElement;
      if ([...parent.querySelectorAll("a[href]")].some((x) => x.href !== a.href)) break;
      el = parent;
    }
    // Join the text pieces with spaces: textContent would glue them together
    // ("Lesson.pdfPDF") and the extension regexes wouldn't match.
    const parts = [a.getAttribute("aria-label"), a.title];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) parts.push(walker.currentNode.data);
    return parts.join(" ");
  }

  function classify(a) {
    const text = cardText(a);
    for (const [type, ext] of TYPE_RULES) if (ext.test(text)) return type;
    for (const [type, , word] of TYPE_RULES) if (word.test(text)) return type;
    return "other";
  }

  /** Readable title of the attachment. */
  function labelOf(a) {
    const aria = a.getAttribute("aria-label");
    if (aria) return aria.trim();
    return (a.innerText || a.textContent).split("\n").map((s) => s.trim()).find(Boolean) || "";
  }

  /** All downloadable attachments on the page. */
  function scanFiles() {
    const files = [];
    for (const a of document.querySelectorAll(LINK_SELECTOR)) {
      if (a.closest(`.${UI_CLASS}`)) continue;
      // Skip links without visible text (e.g. thumbnails only): the attachment
      // almost always has a titled link too. The text may show up later, so
      // the link is checked again on the next pass.
      if (!a.textContent.trim()) continue;
      const r = resolve(a.href);
      if (!r) continue;
      files.push({ anchor: a, url: r.url, type: r.type || classify(a), label: labelOf(a) });
    }
    return files;
  }

  function uniqueByUrl(files) {
    return [...new Map(files.map((f) => [f.url, f])).values()];
  }

  function commonAncestor(nodes) {
    let a = nodes[0];
    for (const n of nodes) while (!a.contains(n)) a = a.parentElement;
    return a;
  }

  /** Makes a string safe to use as a file or folder name. */
  function cleanName(s) {
    return normalize(s).replace(/[<>:"/\\|?*\u0000-\u001f~]/g, "_").replace(/[. ]+$/, "").slice(0, 80);
  }

  /** Course (or post) name, from the tab title. */
  function pageName() {
    const name = document.title.replace(/\s*[-–—|]\s*(Google\s+)?Classroom\s*$/i, "");
    return /^\s*(google\s+)?classroom\s*$/i.test(name) ? "" : cleanName(name);
  }

  /** Downloads folder: Classroom/<course>, when the option is on. */
  function courseFolder() {
    if (!settings.courseFolder) return "";
    const name = pageName();
    return name ? `Classroom/${name}` : "Classroom";
  }

  function joinPath(...parts) {
    return parts.filter(Boolean).join("/");
  }

  function zipFilename() {
    const date = new Date().toISOString().slice(0, 10);
    return joinPath(courseFolder(), `${pageName() || "posts"} - ${date}.zip`);
  }

  function sendMessage(msg) {
    return new Promise((resolvePromise) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolvePromise({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolvePromise(res || { ok: false });
        }
      });
    });
  }

  // Whoever started the current ZIP gets { done, total } updates here.
  let zipProgressHandler = null;

  /**
   * Downloads several files: as a single ZIP (only one save prompt) or as
   * separate files. file.folder is the post title: with the "folder per post"
   * option it becomes a subfolder (inside the ZIP or in Downloads).
   */
  async function downloadFiles(files, onProgress) {
    // Post folders only when the option is on and the files come from different posts.
    const usePostFolders = settings.postFolders && new Set(files.map((f) => f.folder || "")).size > 1;
    const postFolder = (f) => (usePostFolders && f.folder ? cleanName(f.folder) : "");

    if (settings.zip && files.length > 1) {
      zipProgressHandler = onProgress;
      try {
        return await sendMessage({
          type: "downloadZip",
          filename: zipFilename(),
          baseFolder: courseFolder(), // where videos / large files kept out of the ZIP go
          files: files.map((f) => ({ url: f.url, name: f.label, folder: postFolder(f), type: f.type })),
        });
      } finally {
        zipProgressHandler = null;
      }
    }
    return sendMessage({
      type: "downloadMany",
      items: files.map((f) => ({ url: f.url, name: f.label, folder: joinPath(courseFolder(), postFolder(f)) })),
    });
  }

  /** Bulk download + progress card for whatever ended up in the background queue. */
  async function bulkDownload(files, onProgress) {
    const res = await downloadFiles(files, onProgress);
    if (res.ok && (res.queued || res.separate)) progressCard.start();
    return res;
  }

  function resultText(res) {
    if (!res.ok) return t("errorPrefix", res.error || t("downloadFailed"));
    const parts = [];
    if (res.zip) parts.push(t("zipReady", res.started));
    if (res.queued) parts.push(t("downloadsQueued", res.queued));
    if (res.separate) parts.push(t("separateStarted", res.separate));
    const what = parts.join(" · ");
    if (!res.failed) return `${what}.`;
    const names = res.failedNames?.length ? `: ${res.failedNames.join(", ")}` : "";
    return t("someFailed", what, res.failed, names);
  }

  /** Stops Classroom from reacting to clicks on our elements (e.g. opening the preview). */
  function shieldEvents(el, { preventClick = false } = {}) {
    for (const type of ["mousedown", "pointerdown", "mouseup", "pointerup"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (preventClick) e.preventDefault();
    });
  }

  function setText(el, text) {
    // Writing the same text still mutates the DOM, which would re-trigger the
    // observer forever.
    if (el.textContent !== text) el.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Download icon next to every attachment
  // ---------------------------------------------------------------------------

  // Link → its button. We don't permanently mark links as "done": Classroom
  // reuses elements and rewrites their content, deleting our button, so every
  // pass checks that it's still there.
  const buttons = new WeakMap();

  function setState(btn, state) {
    btn.dataset.state = state;
    btn.innerHTML = ICONS[state] || ICONS.download;
    if (state === "done" || state === "error") {
      setTimeout(() => setState(btn, "idle"), 2000);
    }
  }

  function createButton(file) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${BTN_CLASS} ${UI_CLASS}`;
    btn.title = file.label ? t("downloadNamed", file.label) : t("download");
    btn.setAttribute("aria-label", btn.title);
    btn.dataset.url = file.url;
    setState(btn, "idle");

    shieldEvents(btn, { preventClick: true });
    btn.addEventListener("click", async () => {
      if (btn.dataset.state === "loading") return;
      btn.dataset.state = "loading";
      const res = await sendMessage({ type: "download", url: btn.dataset.url });
      if (!res.ok) console.warn("[Classroom Quick Download]", res.error);
      setState(btn, res.ok ? "done" : "error");
    });
    return btn;
  }

  function addIcons(files) {
    for (const file of files) {
      const a = file.anchor;

      // Button still in place and for the same file: nothing to do.
      const existing = buttons.get(a);
      if (existing?.isConnected && existing.dataset.url === file.url) continue;
      existing?.remove();

      // Only one button per file within the same container.
      const parent = a.parentElement;
      if (!parent) continue;
      if ([...parent.querySelectorAll(`.${BTN_CLASS}`)].some((b) => b.dataset.url === file.url)) {
        continue;
      }

      const btn = createButton(file);
      a.insertAdjacentElement("afterend", btn);
      buttons.set(a, btn);
    }
  }

  // ---------------------------------------------------------------------------
  // "Download all" on the page of a single assignment / material / announcement
  // ---------------------------------------------------------------------------

  let allBtn = null;
  let allFiles = [];
  let allBtnBusy = false;

  function isDetailPage() {
    return /\/c\/[^/]+\/(a|m|p|sa|mc)\/[^/]+/.test(location.pathname);
  }

  function createAllButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cqd-all-btn ${UI_CLASS}`;
    btn.innerHTML = `${ICONS.download}<span></span>`;
    shieldEvents(btn, { preventClick: true });
    btn.addEventListener("click", async () => {
      if (allBtnBusy) return;
      allBtnBusy = true;
      const label = btn.querySelector("span");
      label.textContent = settings.zip ? t("zipPreparing") : t("startingDownloads", allFiles.length);
      const res = await bulkDownload(allFiles, ({ done, total }) => {
        label.textContent = t("zipProgress", done, total);
      });
      label.textContent = resultText(res);
      setTimeout(() => {
        allBtnBusy = false;
        refresh();
      }, 4000);
    });
    return btn;
  }

  function updateDownloadAll(files) {
    const unique = uniqueByUrl(files);
    allFiles = unique;
    if (!isDetailPage() || unique.length < 2 || selection.active) {
      if (allBtn?.isConnected) allBtn.remove();
      return;
    }
    allBtn ??= createAllButton();
    if (!allBtnBusy) setText(allBtn.querySelector("span"), t("downloadAll", unique.length));

    const root = commonAncestor(files.map((f) => f.anchor));
    if (root.parentElement && allBtn.nextElementSibling !== root) {
      root.parentElement.insertBefore(allBtn, root);
    }
  }

  // ---------------------------------------------------------------------------
  // Finding posts
  // ---------------------------------------------------------------------------

  /** Amount of text in an element that isn't inside links or our own elements. */
  function extraTextLength(el) {
    let n = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement.closest(`a, script, style, .${UI_CLASS}`)) continue;
      n += walker.currentNode.data.trim().length;
    }
    return n;
  }

  /**
   * A post has something besides its attachments: author and date, text,
   * buttons (menu, comments). A single attachment card doesn't.
   */
  function looksLikePost(el) {
    if (extraTextLength(el) >= 20) return true;
    return [...el.querySelectorAll('button, [role="button"], textarea, input')].some(
      (c) => !c.closest(`a, .${UI_CLASS}`)
    );
  }

  function climbToPost(el) {
    for (let i = 0; i < 12 && el.parentElement && el !== document.body; i++) {
      if (el.tagName !== "A" && looksLikePost(el)) return el;
      el = el.parentElement;
    }
    return el;
  }

  /**
   * Groups attachments by post. Stream posts are siblings in the same list:
   * starting from the common ancestor of all attachments, each child that
   * contains attachments is a post. If the children are just attachment cards
   * instead (a single post on the page), we climb up to the post.
   */
  function groupPosts(files) {
    if (!files.length) return [];
    const root = commonAncestor(files.map((f) => f.anchor));

    const byChild = new Map();
    for (const f of files) {
      let el = f.anchor;
      if (el !== root) while (el.parentElement !== root) el = el.parentElement;
      if (!byChild.has(el)) byChild.set(el, []);
      byChild.get(el).push(f);
    }

    let groups = [...byChild.entries()];
    const onlyAttachmentCards = groups.every(
      ([el, fs]) => new Set(fs.map((f) => f.url)).size === 1 && !looksLikePost(el)
    );
    if (groups.length === 1 || onlyAttachmentCards) {
      groups = [[climbToPost(root), files]];
    }

    return groups.map(([container, fs]) => {
      const unique = uniqueByUrl(fs);
      return { container, files: unique, key: unique.map((f) => f.url).sort().join("|") };
    });
  }

  // ---------------------------------------------------------------------------
  // "Collapsed" stream posts (materials, assignments): the stream only shows a
  // clickable row, the attachments aren't on the page. We open the post page in
  // an invisible iframe, where this same content script reads it and sends us
  // the files.
  // ---------------------------------------------------------------------------

  const PROBE_PREFIX = "cqd-probe:";
  const PROBE_CONCURRENCY = 4;
  const remote = {
    cache: new Map(), // post id → { state: "done" | "error", files }
    jobs: new Map(), // post id → page being loaded
    items: [],
    ticker: null,
  };

  /** Classroom puts IDs in URLs as base64(id + "Z"). */
  const encodeId = (id) => btoa(`${id}Z`).replace(/=+$/, "");

  /** Stream posts that are only a link to their own page. */
  function remoteItems(files) {
    const out = new Map();
    for (const el of document.querySelectorAll("[data-stream-item-id]")) {
      const id = el.dataset.streamItemId;
      if (out.has(id) || el.closest(`.${UI_CLASS}`)) continue;
      let top = el;
      let up;
      while ((up = top.parentElement?.closest(`[data-stream-item-id="${id}"]`))) top = up;

      const link = top.querySelector('[role="link"]');
      if (!link) continue; // announcements: their content is already on the page
      if (files.some((f) => top.contains(f.anchor))) continue;

      // aria-label: Material: "10 - First Order Logic"  (or Materiale: "…" in Italian)
      const m = (link.getAttribute("aria-label") || "").match(/^([^:]+):\s*"([\s\S]*)"\s*$/);
      const title = normalize(m ? m[2] : top.querySelector("h2")?.textContent || "");
      const kind = m ? m[1].trim() : "";
      const isMaterial =
        top.querySelector("[data-type]")?.dataset.type === "2" ||
        top.querySelector("i")?.textContent.trim() === "book" ||
        /material/i.test(kind);
      out.set(id, { id, container: top, title, segs: isMaterial ? ["m", "a", "p"] : ["a", "m", "p"] });
    }
    return [...out.values()];
  }

  function probeUrl(id, seg) {
    const prefix = location.pathname.match(/^(.*?\/u\/\d+)\//)?.[1] ?? "";
    const course = location.pathname.match(/\/(?:c|w)\/([^/]+)/)?.[1];
    return `${prefix}/c/${course}/${seg}/${encodeId(id)}/details`;
  }

  function pumpProbes() {
    if (!selection.active) return;
    const pending = remote.items.filter((it) => !remote.cache.has(it.id) && !remote.jobs.has(it.id));
    // Posts the user already selected go first.
    const isSel = (it) => (selection.selected.has(`item:${it.id}`) ? 1 : 0);
    pending.sort((a, b) => isSel(b) - isSel(a));
    while (remote.jobs.size < PROBE_CONCURRENCY && pending.length) {
      const job = { item: pending.shift(), segIndex: 0, iframe: null };
      remote.jobs.set(job.item.id, job);
      loadSegment(job);
    }
    if (remote.jobs.size && !remote.ticker) remote.ticker = setInterval(tickProbes, 500);
  }

  /** Loads the post page; if the guessed type (m/a/p) is wrong, tries the next one. */
  function loadSegment(job) {
    job.iframe?.remove();
    Object.assign(job, { startedAt: Date.now(), readyAt: 0, stableSince: 0, files: [], lastCount: -1, hello: false });
    const frame = document.createElement("iframe");
    frame.className = UI_CLASS;
    frame.name = PROBE_PREFIX + JSON.stringify({ id: job.item.id, title: job.item.title });
    // No allow-top-navigation: the hidden page can't navigate your tab away.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText =
      "position:fixed;top:0;left:0;width:1024px;height:768px;opacity:0;pointer-events:none;z-index:-1;border:0;";
    frame.src = probeUrl(job.item.id, job.item.segs[job.segIndex]);
    job.iframe = frame;
    document.body.appendChild(frame);
  }

  function finishJob(job, result) {
    job.iframe?.remove();
    remote.jobs.delete(job.item.id);
    remote.cache.set(job.item.id, result);
    pumpProbes();
    refresh();
  }

  function tickProbes() {
    const now = Date.now();
    for (const job of [...remote.jobs.values()]) {
      if (job.readyAt) {
        // Right page: wait until the attachment list stops changing.
        if (now - job.stableSince >= 2000 && now - job.readyAt >= 2500) {
          finishJob(job, { state: "done", files: job.files });
        }
      } else if (!job.item.title && job.hello && now - job.startedAt > 12000) {
        finishJob(job, { state: "done", files: job.files });
      } else if (now - job.startedAt > 15000) {
        if (++job.segIndex < job.item.segs.length) loadSegment(job);
        else finishJob(job, { state: "error", files: [] });
      }
    }
    if (!remote.jobs.size) {
      clearInterval(remote.ticker);
      remote.ticker = null;
    }
  }

  function stopProbes() {
    for (const job of remote.jobs.values()) job.iframe?.remove();
    remote.jobs.clear();
    clearInterval(remote.ticker);
    remote.ticker = null;
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || typeof e.data?.cqdProbe !== "string") return;
    const job = remote.jobs.get(e.data.cqdProbe);
    if (!job || e.source !== job.iframe?.contentWindow) return;
    const now = Date.now();
    const files = Array.isArray(e.data.files) ? e.data.files : [];
    job.hello = true;
    if (files.length !== job.lastCount) {
      job.lastCount = files.length;
      job.stableSince = now;
      job.files = files;
    }
    if (!job.readyAt && (e.data.titleFound || (!job.item.title && files.length))) job.readyAt = now;
  });

  /** Iframe side: reads the attachments of the post page and sends them to the stream. */
  function probeInfo() {
    if (!window.name.startsWith(PROBE_PREFIX)) return null;
    try {
      return JSON.parse(window.name.slice(PROBE_PREFIX.length));
    } catch {
      return null;
    }
  }

  function runProbe(info) {
    const title = normalize(info.title || "");
    const report = () => {
      const files = uniqueByUrl(scanFiles()).map(({ url, type, label }) => ({ url, type, label }));
      const titleFound = !!title && normalize(document.body?.innerText || "").includes(title);
      window.parent.postMessage({ cqdProbe: info.id, files, titleFound }, location.origin);
    };
    report();
    setInterval(report, 700);
  }

  // ---------------------------------------------------------------------------
  // Selection mode
  // ---------------------------------------------------------------------------

  const selection = {
    active: false,
    selected: new Set(), // keys of the selected posts (survive re-renders)
    disabledTypes: new Set(),
    nameFilter: "",
    posts: [],
    bars: new Map(), // post key → { bar, container }
    host: null,
    ui: null,
    busy: false,
  };

  function summarize(files) {
    const counts = {};
    for (const f of files) counts[f.type] = (counts[f.type] || 0) + 1;
    const parts = Object.entries(counts).map(([type, n]) => `${n} ${typeLabel(type)}`);
    const count = files.length === 1 ? t("fileCountOne") : t("fileCountMany", files.length);
    return t("fileSummary", count, parts.join(", "));
  }

  function createPostBar(key) {
    const bar = document.createElement("label");
    bar.className = `cqd-post-bar ${UI_CLASS}`;
    bar.innerHTML = `<input type="checkbox"><span class="cqd-post-title">${escapeHtml(t("selectPost"))}</span><span class="cqd-post-info"></span>`;
    shieldEvents(bar);
    bar.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selection.selected.add(key);
      else selection.selected.delete(key);
      refresh();
    });
    return bar;
  }

  function postInfo(post) {
    if (post.state === "loading") return t("readingAttachments");
    if (post.state === "error") return t("attachmentsUnreadable");
    return post.files.length ? summarize(post.files) : t("noAttachments");
  }

  function renderPosts(files) {
    const posts = groupPosts(files);
    remote.items = remoteItems(files);
    for (const item of remote.items) {
      const cached = remote.cache.get(item.id);
      posts.push({
        container: item.container,
        files: cached?.files || [],
        key: `item:${item.id}`,
        title: item.title,
        state: cached ? cached.state : "loading",
      });
    }
    selection.posts = posts;
    pumpProbes();
    const seen = new Set();

    for (const post of posts) {
      seen.add(post.key);
      let entry = selection.bars.get(post.key);
      if (!entry) {
        entry = { bar: createPostBar(post.key), container: null };
        selection.bars.set(post.key, entry);
      }
      if (entry.container && entry.container !== post.container) {
        entry.container.classList.remove("cqd-post", "cqd-post-selected");
      }
      entry.container = post.container;
      if (entry.bar.parentElement !== post.container) post.container.prepend(entry.bar);

      const isSelected = selection.selected.has(post.key);
      entry.bar.querySelector("input").checked = isSelected;
      setText(entry.bar.querySelector(".cqd-post-info"), postInfo(post));
      post.container.classList.add("cqd-post");
      post.container.classList.toggle("cqd-post-selected", isSelected);
    }

    for (const [key, entry] of selection.bars) {
      if (seen.has(key)) continue;
      entry.bar.remove();
      entry.container?.classList.remove("cqd-post", "cqd-post-selected");
      selection.bars.delete(key);
    }
  }

  /** Files to download: selected posts, filtered by type and name, no duplicates. */
  function filesToDownload() {
    const name = selection.nameFilter.trim().toLowerCase();
    const out = new Map();
    for (const post of selection.posts) {
      if (!selection.selected.has(post.key)) continue;
      for (const f of post.files) {
        if (selection.disabledTypes.has(f.type)) continue;
        if (name && !f.label.toLowerCase().includes(name)) continue;
        if (!out.has(f.url)) out.set(f.url, { ...f, folder: post.title || "" });
      }
    }
    return [...out.values()];
  }

  const TOOLBAR_CSS = `
    :host { all: initial; }
    .panel {
      box-sizing: border-box;
      width: min(640px, calc(100vw - 32px));
      font: 13px/1.4 "Google Sans", Roboto, system-ui, sans-serif;
      color: #202124;
      background: #fff;
      border: 1px solid #dadce0;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(60, 64, 67, 0.25);
      padding: 12px 14px;
      display: grid;
      gap: 10px;
    }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .title { font-weight: 600; }
    .count { color: #5f6368; }
    .spacer { flex: 1; }
    button {
      font: inherit;
      border: 1px solid #dadce0;
      background: #fff;
      color: #1a73e8;
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { background: #f1f3f4; }
    button.close { border: 0; color: #5f6368; font-size: 18px; line-height: 1; padding: 2px 6px; }
    button.primary { background: #1e8e3e; border-color: #1e8e3e; color: #fff; font-weight: 600; padding: 6px 14px; }
    button.primary:hover { background: #188038; }
    button:disabled { opacity: 0.5; cursor: default; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border-radius: 999px;
      padding: 2px 10px;
      color: #3c4043;
      background: #e6f4ea;
      border-color: #a8dab5;
    }
    .chip.off { background: #fff; color: #9aa0a6; text-decoration: line-through; border-color: #dadce0; }
    .chips-label { color: #5f6368; margin-right: 2px; }
    input[type="search"] {
      font: inherit;
      flex: 1 1 160px;
      min-width: 0;
      padding: 5px 8px;
      border: 1px solid #dadce0;
      border-radius: 6px;
      color: inherit;
      background: transparent;
    }
    label.folder { display: inline-flex; align-items: center; gap: 4px; color: #5f6368; }
    .status { color: #188038; min-height: 0; }
    .status:empty { display: none; }
  `;

  function buildToolbar() {
    const host = document.createElement("div");
    host.className = UI_CLASS;
    host.style.cssText =
      "position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);";
    const root = host.attachShadow({ mode: "open" });
    const h = (key) => escapeHtml(t(key));
    root.innerHTML = `
      <style>${TOOLBAR_CSS}</style>
      <div class="panel" role="dialog" aria-label="${h("selectionMode")}">
        <div class="row">
          <span class="title">${h("selectionMode")}</span>
          <span class="count" id="count"></span>
          <span class="spacer"></span>
          <button id="all">${h("selectAll")}</button>
          <button id="none">${h("selectNone")}</button>
          <button id="close" class="close" title="${h("exitEsc")}" aria-label="${h("exit")}">×</button>
        </div>
        <div class="row chips" id="chips"></div>
        <div class="row">
          <input type="search" id="filter" placeholder="${h("filterPlaceholder")}">
          <label class="folder" title="${h("singleZipHint")}"><input type="checkbox" id="zip">${h("singleZip")}</label>
          <label class="folder" title="${h("postFoldersHint")}"><input type="checkbox" id="postFolders">${h("postFolders")}</label>
          <label class="folder" id="folderLabel"><input type="checkbox" id="folder"><span id="folderName"></span></label>
          <button id="go" class="primary"></button>
        </div>
        <div class="status" id="status"></div>
      </div>`;

    // Classroom has keyboard shortcuts: they must not fire while typing in the filter.
    for (const type of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(type, (e) => {
        if (e.key === "Escape") exitSelection();
        e.stopPropagation();
      });
    }

    const $ = (id) => root.getElementById(id);
    $("close").addEventListener("click", exitSelection);
    $("all").addEventListener("click", () => {
      for (const p of selection.posts) selection.selected.add(p.key);
      refresh();
    });
    $("none").addEventListener("click", () => {
      selection.selected.clear();
      refresh();
    });
    $("filter").addEventListener("input", (e) => {
      selection.nameFilter = e.target.value;
      updateToolbar();
    });
    $("folder").addEventListener("change", (e) => {
      chrome.storage.sync.set({ courseFolder: e.target.checked });
    });
    $("zip").addEventListener("change", (e) => {
      chrome.storage.sync.set({ zip: e.target.checked });
    });
    $("postFolders").addEventListener("change", (e) => {
      chrome.storage.sync.set({ postFolders: e.target.checked });
    });
    $("chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-type]");
      if (!chip) return;
      const type = chip.dataset.type;
      if (selection.disabledTypes.has(type)) selection.disabledTypes.delete(type);
      else selection.disabledTypes.add(type);
      updateToolbar();
    });
    $("go").addEventListener("click", async () => {
      const files = filesToDownload();
      if (!files.length || selection.busy) return;
      selection.busy = true;
      $("status").textContent =
        settings.zip && files.length > 1 ? t("zipPreparing") : t("startingDownloads", files.length);
      updateToolbar();
      try {
        const res = await bulkDownload(files, ({ done, total }) => {
          $("status").textContent = t("zipProgress", done, total);
        });
        selection.lastResult = res;
        $("status").textContent = resultText(res);
      } catch (err) {
        selection.lastResult = { error: String(err) };
        $("status").textContent = t("errorPrefix", err);
      } finally {
        selection.busy = false;
        updateToolbar();
      }
    });

    selection.host = host;
    selection.ui = $;
    document.body.appendChild(host);
  }

  function updateToolbar() {
    const $ = selection.ui;
    if (!$) return;
    const posts = selection.posts;
    const selectedCount = posts.filter((p) => selection.selected.has(p.key)).length;
    const remotePosts = posts.filter((p) => p.state);
    const loading = remotePosts.filter((p) => p.state === "loading").length;
    const waiting = posts.filter((p) => p.state === "loading" && selection.selected.has(p.key)).length;
    $("count").textContent =
      t("postsSelected", selectedCount, posts.length) +
      (loading ? t("readingProgress", remotePosts.length - loading, remotePosts.length) : "");

    // Type filters: only the types present on the page, with their counts.
    const counts = {};
    for (const f of uniqueByUrl(posts.flatMap((p) => p.files))) {
      counts[f.type] = (counts[f.type] || 0) + 1;
    }
    $("chips").innerHTML =
      `<span class="chips-label">${escapeHtml(t("types"))}</span>` +
      TYPES.filter((type) => counts[type])
        .map((type) => {
          const off = selection.disabledTypes.has(type);
          return (
            `<button class="chip${off ? " off" : ""}" data-type="${type}" aria-pressed="${!off}">` +
            `${escapeHtml(typeLabel(type))} (${counts[type]})</button>`
          );
        })
        .join("");

    $("zip").checked = settings.zip;
    $("postFolders").checked = settings.postFolders;
    $("folder").checked = settings.courseFolder;
    const name = pageName();
    $("folderName").textContent = name ? t("courseFolderShort") : "Classroom/";
    $("folderLabel").title = t("courseFolderHint", name ? `${name}/` : "");

    const n = filesToDownload().length;
    $("go").textContent = selection.busy
      ? t("downloading")
      : waiting
        ? t("waitingPosts", waiting)
        : n === 1
          ? t("downloadOne")
          : t("downloadN", n);
    $("go").disabled = n === 0 || selection.busy || waiting > 0;
  }

  function enterSelection() {
    if (selection.active) return;
    selection.active = true;
    // Posts that couldn't be read last time get another try.
    for (const [id, r] of remote.cache) if (r.state === "error") remote.cache.delete(id);
    buildToolbar();
    refresh();
  }

  function exitSelection() {
    if (!selection.active) return;
    selection.active = false;
    stopProbes();
    for (const entry of selection.bars.values()) {
      entry.bar.remove();
      entry.container?.classList.remove("cqd-post", "cqd-post-selected");
    }
    selection.bars.clear();
    selection.posts = [];
    selection.host?.remove();
    selection.host = null;
    selection.ui = null;
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Progress card for the background download queue (bottom right)
  // ---------------------------------------------------------------------------

  function formatBytes(n) {
    if (!n) return "0 MB";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
  }

  const CARD_CSS = `
    :host { all: initial; }
    .card {
      box-sizing: border-box;
      width: min(340px, calc(100vw - 32px));
      font: 13px/1.4 "Google Sans", Roboto, system-ui, sans-serif;
      color: #202124;
      background: #fff;
      border: 1px solid #dadce0;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(60, 64, 67, 0.25);
      padding: 12px 14px;
      display: grid;
      gap: 8px;
    }
    .head { display: flex; align-items: center; gap: 8px; }
    .title { font-weight: 600; flex: 1; }
    .bar { height: 6px; border-radius: 3px; background: #e6f4ea; overflow: hidden; }
    .fill { height: 100%; background: #1e8e3e; transition: width 0.4s; }
    .meta, .failed { color: #5f6368; }
    .failed { color: #d93025; }
    .meta:empty, .failed:empty, .files:empty { display: none; }
    .files { display: grid; gap: 4px; max-height: 140px; overflow: auto; }
    .file { display: grid; grid-template-columns: 1fr auto; gap: 8px; color: #3c4043; }
    .file span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file span:last-child { color: #5f6368; font-variant-numeric: tabular-nums; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .actions:empty { display: none; }
    button {
      font: inherit;
      border: 1px solid #dadce0;
      background: #fff;
      color: #1a73e8;
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { background: #f1f3f4; }
    button.close { border: 0; color: #5f6368; font-size: 18px; line-height: 1; padding: 2px 6px; }
  `;

  const progressCard = {
    host: null,
    timer: null,

    build() {
      const host = document.createElement("div");
      host.className = UI_CLASS;
      host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>${CARD_CSS}</style>
        <div class="card" role="status" aria-live="polite">
          <div class="head">
            <span class="title" id="title"></span>
            <button class="close" id="close" title="${escapeHtml(t("close"))}" aria-label="${escapeHtml(t("close"))}">×</button>
          </div>
          <div class="bar"><div class="fill" id="fill"></div></div>
          <div class="meta" id="meta"></div>
          <div class="files" id="files"></div>
          <div class="failed" id="failed"></div>
          <div class="actions" id="actions"></div>
        </div>`;
      shieldEvents(host);
      const $ = (id) => root.getElementById(id);
      $("close").addEventListener("click", () => this.hide());
      $("actions").addEventListener("click", async (e) => {
        const action = e.target.closest("button")?.dataset.action;
        if (action === "cancel") await sendMessage({ type: "queueCancel" });
        if (action === "show") await sendMessage({ type: "queueShowFolder" });
        this.poll();
      });
      this.$ = $;
      this.host = host;
      document.body.appendChild(host);
    },

    /** Shows the card and follows the queue until it's empty. */
    start() {
      if (!this.host) this.build();
      if (!this.host.isConnected) document.body.appendChild(this.host);
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), 1000);
      this.poll();
    },

    hide() {
      clearInterval(this.timer);
      this.timer = null;
      this.host?.remove();
    },

    async poll() {
      const s = await sendMessage({ type: "queueStatus" });
      if (!this.host || s.ok === false || s.total == null) return;
      const $ = this.$;
      const running = s.active.length + s.pending;
      const finished = s.done + s.failed.length;

      $("title").textContent = s.cancelled
        ? t("queueCancelled")
        : running
          ? t("queueTitle", s.done, s.total)
          : t("queueFinished", s.done, s.total);
      $("fill").style.width = `${s.total ? Math.round((finished / s.total) * 100) : 0}%`;

      const meta = [];
      if (s.active.length) meta.push(t("queueActive", s.active.length));
      if (s.pending) meta.push(t("queuePending", s.pending));
      meta.push(t("queueBytes", formatBytes(s.bytes)));
      $("meta").textContent = meta.join(" · ");

      $("files").innerHTML = s.active
        .map((f) => {
          const pct = f.total > 0 ? `${Math.floor((f.received / f.total) * 100)}%` : formatBytes(f.received);
          return `<div class="file"><span>${escapeHtml(f.name || "…")}</span><span>${pct}</span></div>`;
        })
        .join("");
      $("failed").textContent = s.failed.length ? t("queueFailed", s.failed.length, s.failed.join(", ")) : "";

      const actions = [];
      if (running) actions.push(`<button data-action="cancel">${escapeHtml(t("queueCancel"))}</button>`);
      else if (s.canShow) actions.push(`<button data-action="show">${escapeHtml(t("queueShowFolder"))}</button>`);
      $("actions").innerHTML = actions.join("");

      if (!running) {
        clearInterval(this.timer);
        this.timer = null;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  function refresh() {
    const files = scanFiles();
    addIcons(files);
    updateDownloadAll(files);
    if (selection.active) {
      renderPosts(files);
      updateToolbar();
    }
  }

  // In iframes: if it's one of our hidden pages, read its attachments;
  // otherwise do nothing (icons and panel live only in the main page).
  if (window !== window.top) {
    const info = probeInfo();
    if (info) {
      chrome.storage.sync.get(DEFAULTS).then((s) => {
        settings = s;
        runProbe(info);
      });
    }
    return;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "getStatus") {
      const files = scanFiles();
      const closed = remoteItems(files).length;
      sendResponse({
        selectionActive: selection.active,
        files: uniqueByUrl(files).length,
        posts: groupPosts(files).length + closed,
        closed,
      });
    } else if (msg?.type === "zipProgress") {
      zipProgressHandler?.(msg);
    } else if (msg?.type === "toggleSelection") {
      if (selection.active) exitSelection();
      else enterSelection();
      sendResponse({ selectionActive: selection.active });
    }
  });

  // Diagnostics. The content script lives in a "world" separate from the page,
  // so the regular console can't see it; DOM events do get through. In the console:
  //   document.dispatchEvent(new Event("cqd-debug")); copy(document.documentElement.dataset.cqdDebug)
  const debugDump = () => {
    const describe = (el) => {
      if (!el || el.nodeType !== 1) return String(el);
      const attrs = [...el.attributes]
        .filter((a) => !["style", "href", "src", "jsaction", "jslog"].includes(a.name))
        .map((a) => (a.name === "class" ? `.${a.value.trim().split(/\s+/).join(".")}` : `[${a.name}${a.value.length < 40 ? `="${a.value}"` : ""}]`))
        .join("");
      return `${el.tagName.toLowerCase()}${attrs}`;
    };
    const files = scanFiles();
    const root = files.length ? commonAncestor(files.map((f) => f.anchor)) : null;
    const posts = groupPosts(files);
    return JSON.stringify(
      {
        url: location.pathname,
        title: document.title,
        selectionActive: selection.active,
        selectedKeys: selection.selected.size,
        disabledTypes: [...selection.disabledTypes],
        nameFilter: selection.nameFilter,
        toDownload: selection.active ? filesToDownload().length : null,
        lastResult: selection.lastResult ?? null,
        root: describe(root),
        files: files.map((f) => ({ label: f.label, type: f.type, url: f.url.slice(0, 90) })),
        posts: posts.map((p) => ({
          container: describe(p.container),
          files: p.files.length,
          selected: selection.selected.has(p.key),
          extraText: extraTextLength(p.container),
        })),
        // Ancestors from the first links up to the common ancestor.
        chain: files.slice(0, 3).map((f) => {
          const out = [];
          for (let el = f.anchor; el && el !== root?.parentElement; el = el.parentElement) out.push(describe(el));
          return out;
        }),
      },
      null,
      2
    );
  };
  document.addEventListener("cqd-debug", () => {
    document.documentElement.dataset.cqdDebug = debugDump();
  });

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = s;
    refresh();
  });

  // Downloads still running from earlier (other tab, page reload): show their progress.
  sendMessage({ type: "queueStatus" }).then((s) => {
    if (s.active?.length || s.pending) progressCard.start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
    refresh();
  });

  // Classroom is a single-page app: watch the DOM for changes.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
