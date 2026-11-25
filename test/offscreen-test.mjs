// Checks which files offscreen.js puts in the ZIP and which it leaves out as
// separate downloads (videos, large files, Drive's virus-scan page).
// Usage: node test/offscreen-test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const MB = 1024 * 1024;
const PDF = new TextEncoder().encode("%PDF-1.4 small");
const WARNING = `<form id="download-form" action="https://drive.usercontent.google.com/download">
<input type="hidden" name="id" value="BIGZIP"><input type="hidden" name="uuid" value="u-1"></form>`;

// id → fake response
const RESPONSES = {
  PDF: { type: "application/pdf", length: PDF.length, body: PDF, cd: `attachment; filename="notes.pdf"` },
  VIDEO: { type: "video/mp4", length: 800 * MB },
  HUGE: { type: "application/zip", length: 300 * MB },
  BIGZIP: { type: "text/html; charset=utf-8", html: WARNING },
};
const fetched = [];
let aborted = 0;

async function fakeFetch(url, { signal } = {}) {
  const id = new URL(url).searchParams.get("id");
  fetched.push(id);
  signal?.addEventListener("abort", () => aborted++);
  const r = RESPONSES[id];
  let sent = false;
  return {
    ok: true,
    status: 200,
    url,
    headers: new Map([
      ["content-type", r.type],
      ["content-length", String(r.length ?? 0)],
      ["content-disposition", r.cd ?? null],
    ]),
    text: async () => r.html,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: r.body })),
      }),
    },
  };
}

class FakeURL extends URL {
  static createObjectURL() {
    return "blob:zip";
  }
}

let onMessage;
const ctx = vm.createContext({
  URL: FakeURL, AbortController, TextEncoder, Blob, Uint8Array, Uint32Array, DataView, ArrayBuffer,
  Date, Map, Set, Symbol, Number, String, Promise, Array, parseInt,
  fetch: fakeFetch,
  t: (key) => key,
  chrome: {
    runtime: { onMessage: { addListener: (fn) => (onMessage = fn) }, sendMessage: async () => {} },
  },
});
for (const f of ["drive.js", "zip.js", "offscreen.js"]) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), ctx);
}

const file = (id, extra = {}) => ({
  url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
  name: id,
  folder: "Lesson 1",
  ...extra,
});

const res = await new Promise((resolve) =>
  onMessage(
    {
      target: "offscreen",
      type: "buildZip",
      jobId: "j1",
      tabId: 1,
      files: [file("PDF"), file("VIDEO"), file("HUGE"), file("BIGZIP"), file("CLASSIFIED", { type: "video" })],
    },
    {},
    resolve
  )
);

assert.equal(res.ok, true);
assert.equal(res.count, 1, "only the small PDF goes in the ZIP");
assert.equal(res.url, "blob:zip");
assert.equal(
  res.separate.map((s) => new URL(s.url).searchParams.get("id")).sort().join(","),
  "BIGZIP,CLASSIFIED,HUGE,VIDEO"
);
assert.ok(res.separate.every((s) => s.folder === "Lesson 1"), "separate files keep their post folder");
assert.ok(!fetched.includes("CLASSIFIED"), "files Classroom already marks as video aren't even fetched");
assert.ok(aborted >= 2, "large bodies are not read into memory");
assert.equal(res.failed.length, 0);

// Only large files: no ZIP at all, everything downloaded separately.
const onlyBig = await new Promise((resolve) =>
  onMessage({ target: "offscreen", type: "buildZip", jobId: "j2", tabId: 1, files: [file("VIDEO"), file("HUGE")] }, {}, resolve)
);
assert.equal(onlyBig.ok, true);
assert.equal(onlyBig.url, null);
assert.equal(onlyBig.separate.length, 2);

console.log("offscreen.js: all checks passed");
