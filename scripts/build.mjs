// Packages the extension into dist/classroom-quick-download-<version>.zip,
// ready to upload to the Chrome Web Store or attach to a GitHub release.
// Usage: node scripts/build.mjs
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Only what the extension needs at runtime (no tests, scripts, docs).
const INCLUDE = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "drive.js",
  "i18n.js",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "zip.js",
  "icons",
  "_locales",
];

function walk(path) {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap((f) => walk(join(path, f))) : [path];
}

// Reuse the extension's own ZIP writer.
const ctx = vm.createContext({ TextEncoder, Blob, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date });
vm.runInContext(readFileSync(join(root, "zip.js"), "utf8"), ctx);

const files = INCLUDE.flatMap((p) => walk(join(root, p)));
const entries = files.map((f) => ({
  path: relative(root, f).split(sep).join("/"),
  data: new Uint8Array(readFileSync(f)),
}));

const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const out = join(root, "dist", `classroom-quick-download-${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
const blob = ctx.makeZip(entries);
writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
console.log(`${relative(root, out)}  (${entries.length} files, ${(blob.size / 1024).toFixed(1)} KB)`);
