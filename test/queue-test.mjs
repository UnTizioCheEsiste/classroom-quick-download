// Checks the background download queue: a few downloads at a time, the next
// one starting when one finishes, progress status and cancel.
// Usage: node test/queue-test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// --- fake chrome APIs ---
const session = {};
const downloads = new Map(); // id → { id, url, state, bytesReceived, totalBytes, filename }
let nextId = 1;
let changed, onMessage;
let badge = "";
const cancelled = [];

const chrome = {
  storage: {
    session: {
      get: async (key) =>
        key == null ? structuredClone(session) : { [key]: session[key] && structuredClone(session[key]) },
      set: async (obj) => Object.assign(session, structuredClone(obj)),
      remove: async (key) => delete session[key],
    },
  },
  downloads: {
    onDeterminingFilename: { addListener() {} },
    onChanged: { addListener: (fn) => (changed = fn) },
    download: async ({ url }) => {
      const id = nextId++;
      downloads.set(id, { id, url, state: "in_progress", bytesReceived: 0, totalBytes: 1000, filename: `C:\\Downloads\\${new URL(url).searchParams.get("id")}.mp4` });
      return id;
    },
    search: async ({ id }) => (downloads.has(id) ? [downloads.get(id)] : []),
    cancel: async (id) => cancelled.push(id),
    show() {},
  },
  action: { setBadgeText: ({ text }) => (badge = text), setBadgeBackgroundColor() {} },
  runtime: { onMessage: { addListener: (fn) => (onMessage = fn) }, sendMessage: async () => {} },
  i18n: { getMessage: (k) => k },
  offscreen: {},
};

const ctx = vm.createContext({
  chrome, URL, AbortController, Promise, Object, Array, Map, Set, Number, String, console, structuredClone,
  // Real files on Drive answer with a video, not the virus-scan page.
  fetch: async (url) => ({ url, headers: new Map([["content-type", "video/mp4"]]) }),
  importScripts: (...files) => files.forEach((f) => vm.runInContext(read(f), ctx)),
});
vm.runInContext(read("background.js"), ctx);

const send = (msg) => new Promise((resolve) => onMessage(msg, { tab: { id: 1 } }, resolve));
const finish = async (id, state = "complete") => {
  const d = downloads.get(id);
  Object.assign(d, { state, bytesReceived: 1000, fileSize: 1000 });
  changed({ id, state: { current: state } });
  await send({ type: "queueStatus" }); // waits for the queue update to be applied
};
const activeIds = () => Object.keys(session.queue.active).map(Number);

// 12 videos → only 5 start.
const items = Array.from({ length: 12 }, (_, i) => ({
  url: `https://drive.usercontent.google.com/download?id=V${i + 1}&export=download&confirm=t`,
  name: `V${i + 1}.mp4`,
  folder: "Classroom/Course/Lesson",
}));
const res = await send({ type: "downloadMany", items });
assert.equal(res.ok, true);
assert.equal(res.queued, 12);
assert.equal(downloads.size, 5, "5 downloads at a time");
assert.equal(session.queue.pending.length, 7);
assert.equal(badge, "12");

// Two finish (one fails) → two more start, still 5 running.
const [first, second] = activeIds();
await finish(first);
await finish(second, "interrupted");
assert.equal(downloads.size, 7);
assert.equal(activeIds().length, 5);

let s = await send({ type: "queueStatus" });
assert.equal(s.total, 12);
assert.equal(s.done, 1);
assert.equal(s.failed.join(), "V2.mp4");
assert.equal(s.pending, 5);
assert.equal(s.active.length, 5);
assert.equal(s.bytes, 1000);
assert.equal(s.canShow, true);
assert.equal(badge, "10");

// Downloads that aren't ours are ignored.
changed({ id: 999, state: { current: "complete" } });
s = await send({ type: "queueStatus" });
assert.equal(s.done, 1);

// Cancel: running ones are cancelled, queued ones dropped.
const running = activeIds();
await send({ type: "queueCancel" });
assert.deepEqual([...cancelled].sort(), [...running].sort());
s = await send({ type: "queueStatus" });
assert.equal(s.pending + s.active.length, 0);
assert.equal(s.cancelled, true);
assert.equal(badge, "");
assert.equal(downloads.size, 7, "nothing new started after cancel");

// A new batch after the previous one ended starts from zero.
await send({ type: "downloadMany", items: items.slice(0, 2) });
s = await send({ type: "queueStatus" });
assert.equal(s.total, 2);
assert.equal(s.done, 0);
assert.equal(s.cancelled, false);

console.log("download queue: all checks passed");
