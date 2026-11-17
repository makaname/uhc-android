// Taps an element in the app's WebView on the emulator/device by CSS selector, as a real (trusted)
// touch sent through the DevTools protocol at the element's centre. Debug builds only.
//   node tools/tap.mjs "<css selector>"
import { execFileSync } from "node:child_process";

const ADB = process.env.ADB || `${process.env.HOME || process.env.USERPROFILE}/scoop/apps/android-clt/current/platform-tools/adb.exe`;
const PORT = 9229;
const sel = process.argv[2];
if (!sel) { console.error('Usage: node tools/tap.mjs "<css selector>"'); process.exit(1); }

const pid = execFileSync(ADB, ["shell", "pidof", "uhc.android.reader"]).toString().trim().split(/\s+/)[0];
if (!pid) { console.error("App isn't running"); process.exit(2); }
execFileSync(ADB, ["forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = pages.find((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:8137")) || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

const res = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
  return [r.x + r.width / 2, r.y + r.height / 2]; })()` });
const pos = res.result?.result?.value;
if (!pos) { console.error(`No visible element for ${sel}`); ws.close(); process.exit(3); }

const [x, y] = pos;
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
console.log(`tapped ${sel} at ${Math.round(x)},${Math.round(y)} (CSS px)`);
ws.close();
