// Checks drive.js against Drive's "can't scan this file for viruses" page.
// Usage: node test/drive-test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

let requests = [];
let aborted = 0;
// Fake fetch: answers with the warning page for ?id=BIG, with a video otherwise.
async function fakeFetch(url, { signal } = {}) {
  requests.push(url);
  signal?.addEventListener("abort", () => aborted++);
  const big = new URL(url).searchParams.get("id") === "BIG" && !new URL(url).searchParams.has("uuid");
  return {
    url,
    headers: new Map([["content-type", big ? "text/html; charset=utf-8" : "video/mp4"]]),
    text: async () => WARNING_PAGE,
  };
}

const WARNING_PAGE = `<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
<div class="uc-main"><div id="uc-text"><p class="uc-warning-caption">Google Drive can't scan this file for viruses.</p>
<p class="uc-warning-subcaption"><span class="uc-name-size"><a href="/open?id=BIG">lezione-registrata.mp4</a> (1.2G)</span> is too large for Google to scan for viruses. Would you still like to download this file?</p>
<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
<input type="submit" id="uc-download-link" class="goog-inline-block jfk-button jfk-button-action" value="Download anyway"/>
<input type="hidden" name="id" value="BIG"><input type="hidden" name="export" value="download">
<input type="hidden" name="authuser" value="1"><input type="hidden" name="confirm" value="t">
<input type="hidden" name="uuid" value="3f1c2a9e-7b4d-4e2a-9c1d-0a8b7e6f5d4c"><input type="hidden" name="at" value="APvzH3o&#x3d;abc">
</form></div></div></body></html>`;

const ctx = vm.createContext({ URL, AbortController, fetch: fakeFetch, String, Number, parseInt });
vm.runInContext(readFileSync(new URL("../drive.js", import.meta.url), "utf8"), ctx);

// 1. Current page: form with hidden fields.
const confirm = new URL(ctx.driveConfirmUrl(WARNING_PAGE, "https://drive.usercontent.google.com/download?id=BIG"));
assert.equal(confirm.origin + confirm.pathname, "https://drive.usercontent.google.com/download");
assert.equal(confirm.searchParams.get("id"), "BIG");
assert.equal(confirm.searchParams.get("confirm"), "t");
assert.equal(confirm.searchParams.get("uuid"), "3f1c2a9e-7b4d-4e2a-9c1d-0a8b7e6f5d4c");
assert.equal(confirm.searchParams.get("authuser"), "1");
assert.equal(confirm.searchParams.get("at"), "APvzH3o=abc");

// 2. Older page: a link with a confirm token.
const old = ctx.driveConfirmUrl(
  `<a id="uc-download-link" href="/uc?export=download&amp;confirm=Xy12&amp;id=OLD">Download anyway</a>`,
  "https://drive.google.com/uc?export=download&id=OLD"
);
assert.equal(old, "https://drive.google.com/uc?export=download&confirm=Xy12&id=OLD");

// 3. No warning on the page.
assert.equal(ctx.driveConfirmUrl("<html>nothing here</html>", "https://drive.google.com/"), null);

// 4. bypassDriveWarning: big file → confirm URL; normal file → same URL, body aborted.
const bigUrl = "https://drive.usercontent.google.com/download?id=BIG&export=download&confirm=t&authuser=1";
assert.match(await ctx.bypassDriveWarning(bigUrl), /uuid=3f1c2a9e/);
const smallUrl = "https://drive.usercontent.google.com/download?id=SMALL&export=download&confirm=t";
requests = []; aborted = 0;
assert.equal(await ctx.bypassDriveWarning(smallUrl), smallUrl);
assert.equal(aborted, 1, "the real file's body must not be downloaded twice");

// 5. Non-Drive URLs (Docs exports) aren't touched at all.
requests = [];
const docs = "https://docs.google.com/document/d/X/export?format=pdf";
assert.equal(await ctx.bypassDriveWarning(docs), docs);
assert.equal(requests.length, 0);

console.log("drive.js: all checks passed");
