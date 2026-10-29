// Prova di zip.js e delle funzioni di supporto di offscreen.js.
// Uso: node test/zip-test.mjs <file-di-uscita.zip>
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({
  TextEncoder, Blob, URL, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date, Map, Set,
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
});
for (const f of ["zip.js", "offscreen.js"]) vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), ctx);

const enc = new TextEncoder();
const entries = vm.runInContext("uniquePaths", ctx)([
  { folder: "Lezione 1", name: "slide.pdf", data: enc.encode("%PDF-1 uno") },
  { folder: "Lezione 1", name: "slide.pdf", data: enc.encode("%PDF-1 due") },
  { folder: "", name: "Perché è così.txt", data: enc.encode("àèìòù") },
  { folder: "Esercizi", name: "vuoto", data: new Uint8Array(0) },
]);
const blob = vm.runInContext("makeZip", ctx)(entries);
writeFileSync(process.argv[2], Buffer.from(await blob.arrayBuffer()));

const fromHeader = vm.runInContext("filenameFromHeader", ctx);
console.log(JSON.stringify({
  paths: entries.map((e) => e.path),
  header1: fromHeader(`attachment; filename="Lezione.pdf"; filename*=UTF-8''Lezione%20%C3%A0.pdf`),
  header2: fromHeader(`attachment; filename="esempi.zip"`),
  fallback: vm.runInContext("fallbackName", ctx)("Appunti", "application/pdf"),
}));
