// Real (trusted) touch gestures in the app's WebView on the emulator/device, sent through the
// DevTools protocol. Debug builds only. Coordinates are CSS pixels.
//
//   node tools/gesture.mjs tap "<selector>" [fx fy]        tap at a fraction of the element (default centre)
//   node tools/gesture.mjs doubletap "<selector>" [fx fy]
//   node tools/gesture.mjs swipe left|right|up|down [px]   one-finger swipe across the middle of the screen
//   node tools/gesture.mjs pinch "<selector>" <factor>     two-finger pinch centred on the element (2 = zoom in 2x)
import { execFileSync } from "node:child_process";

const ADB = process.env.ADB || `${process.env.HOME || process.env.USERPROFILE}/scoop/apps/android-clt/current/platform-tools/adb.exe`;
const PORT = 9229;
const [cmd, ...args] = process.argv.slice(2);
const usage = () => { console.error("Usage: node tools/gesture.mjs tap|doubletap|swipe|pinch ..."); process.exit(1); };
if (!cmd) usage();

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const touch = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });

async function eval_(expr) {
  const res = await send("Runtime.evaluate", { returnByValue: true, expression: expr });
  return res.result?.result?.value;
}
async function rectOf(sel) {
  const r = await eval_(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return r.width && r.height ? [r.x, r.y, r.width, r.height] : null; })()`);
  if (!r) { console.error(`No visible element for ${sel}`); ws.close(); process.exit(3); }
  return r;
}
async function at(sel, fx = 0.5, fy = 0.5) {
  const [x, y, w, h] = await rectOf(sel);
  return [x + w * Number(fx), y + h * Number(fy)];
}
async function tap(p) { await touch("touchStart", [p]); await sleep(40); await touch("touchEnd", []); }

if (cmd === "tap" || cmd === "doubletap") {
  const p = await at(args[0], args[1], args[2]);
  await tap(p);
  if (cmd === "doubletap") { await sleep(120); await tap(p); }
  console.log(`${cmd} ${args[0]} at ${p.map(Math.round)}`);
} else if (cmd === "swipe") {
  const [vw, vh] = await eval_("[innerWidth, innerHeight]");
  const dir = args[0], dist = Number(args[1] || vw * 0.6);
  const cx = vw / 2, cy = vh * 0.45;
  const dx = dir === "left" ? -dist : dir === "right" ? dist : 0, dy = dir === "up" ? -dist : dir === "down" ? dist : 0;
  const steps = 10;
  await touch("touchStart", [[cx - dx / 2, cy - dy / 2]]);
  for (let i = 1; i <= steps; i++) { await sleep(16); await touch("touchMove", [[cx - dx / 2 + (dx * i) / steps, cy - dy / 2 + (dy * i) / steps]]); }
  await touch("touchEnd", []);
  console.log(`swipe ${dir} ${Math.round(dist)}px`);
} else if (cmd === "pinch") {
  const [cx, cy] = await at(args[0]);
  const factor = Number(args[1] || 2), r0 = 40, r1 = r0 * factor, steps = 12;
  await touch("touchStart", [[cx - r0, cy], [cx + r0, cy]]);
  for (let i = 1; i <= steps; i++) {
    const r = r0 + ((r1 - r0) * i) / steps;
    await sleep(16);
    await touch("touchMove", [[cx - r, cy], [cx + r, cy]]);
  }
  await touch("touchEnd", []);
  console.log(`pinch x${factor} on ${args[0]}`);
} else usage();
ws.close();
