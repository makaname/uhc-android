// Runs JavaScript inside the app's WebView on a connected device/emulator (debug builds only),
// via adb + Chrome DevTools Protocol.
//   node tools/cdp.mjs "<js expression>"     prints the (awaited) result as JSON
import { execFileSync } from "node:child_process";

const ADB = process.env.ADB || `${process.env.HOME || process.env.USERPROFILE}/scoop/apps/android-clt/current/platform-tools/adb.exe`;
const PORT = 9229;

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

const expr = process.argv[2] || "location.href";
const res = await send("Runtime.evaluate", { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
if (res.result?.exceptionDetails) console.error("ERROR:", res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
else console.log(JSON.stringify(res.result?.result?.value, null, 1));
ws.close();
