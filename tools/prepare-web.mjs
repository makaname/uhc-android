// Builds build/web from the compiled UHC 2.8.1 bundle plus our shim and phone stylesheet.
// The bundle itself is copied unchanged; only index.html is adjusted.
// Usage: node tools/prepare-web.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "vendor", "uhc-2.8.1-app");
const out = path.join(root, "build", "assets", "web");   // packaged into the APK as assets/web

// Files from the Electron app that the WebView doesn't need.
const SKIP = new Set(["background.js", "package.json", "node_modules"]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const entry of fs.readdirSync(src)) {
  if (SKIP.has(entry)) continue;
  fs.cpSync(path.join(src, entry), path.join(out, entry), { recursive: true });
}
fs.cpSync(path.join(root, "shim"), path.join(out, "shim"), { recursive: true });

// Webpack's runtime loads lazy chunks from its public path, which is the Electron-only "app://./".
// This is the one edit to the compiled JS: point it at the page's own folder.
let patchedRuntime = 0;
for (const f of fs.readdirSync(path.join(out, "js"))) {
  const p = path.join(out, "js", f);
  const js = fs.readFileSync(p, "utf8");
  if (js.includes('.p="app://./"')) {
    fs.writeFileSync(p, js.replace('.p="app://./"', '.p="/"'));   // absolute: the router uses real paths like /homestuck/26
    patchedRuntime++;
  }
}
if (patchedRuntime !== 1) throw new Error(`Expected one webpack runtime with app:// public path, found ${patchedRuntime}`);

// The ~80 MB chunk holding imods.tar.gz is only used to re-extract the built-in mods on desktop.
// On the phone they're read straight from the asset pack, so swap it for an empty module.
let strippedImods = 0;
for (const f of fs.readdirSync(path.join(out, "js"))) {
  const p = path.join(out, "js", f);
  if (fs.statSync(p).size < 20e6) continue;
  const head = fs.readFileSync(p, { encoding: "utf8", flag: "r" }).slice(0, 400);
  const m = /push\(\[\["([^"]+)"\],\{"?(\w+)"?:function\(module,__webpack_exports__,__webpack_require__\)\{"use strict";eval\('__webpack_require__\.r\(__webpack_exports__\);\\n\/\* harmony default export \*\/ __webpack_exports__\["default"\] = \("data:application\/gzip;base64,/.exec(head);
  if (!m) continue;
  fs.writeFileSync(p, `(window["webpackJsonp"]=window["webpackJsonp"]||[]).push([["${m[1]}"],{"${m[2]}":function(module,__webpack_exports__,__webpack_require__){"use strict";__webpack_require__.r(__webpack_exports__);__webpack_exports__["default"]="";}}]);`);
  strippedImods++;
}
console.log(strippedImods ? "Dropped desktop-only imods archive chunk" : "Note: imods archive chunk not found (left as is)");

// Static stylesheets reference pack images as url(assets://...). The pack is always served at /pack/.
for (const f of fs.readdirSync(path.join(out, "css"))) {
  const p = path.join(out, "css", f);
  const css = fs.readFileSync(p, "utf8");
  if (css.includes("assets://")) fs.writeFileSync(p, css.replaceAll("assets://", "/pack/"));
}

let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
html = html
  .replaceAll("app://./", "/")
  .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
  .replace("<head>", '<head><script src="/shim/vendor/js-yaml-3.14.1.min.js"></script><script src="/shim/uhc-shim.js"></script><script src="/shim/mobile.js" defer></script><link rel="stylesheet" href="/shim/mobile.css">');
if (!html.includes("uhc-shim.js")) throw new Error("Failed to inject shim into index.html");
fs.writeFileSync(path.join(out, "index.html"), html);

console.log("build/web ready:", out);
