// Measures the app on a connected device/emulator (debug build), for before/after comparisons.
//   node tools/perf.mjs [runs=5] [page=/homestuck/2]
// Reports, as medians over the runs:
//   cold start: process start (force-stop + launch) -> first story panel decoded and reader bar shown
//   page turn:  reader-bar "next" tap -> the next page's panel decoded
//   JS heap after the run
import { execFileSync } from "node:child_process";

const ADB = process.env.ADB || `${process.env.HOME || process.env.USERPROFILE}/scoop/apps/android-clt/current/platform-tools/adb.exe`;
const PKG = "uhc.android.reader";
const PORT = 9229;
const RUNS = Number(process.argv[2] || 5);
const START_PAGE = process.argv[3] || "/homestuck/2";
const TURNS = 10;

const adb = (...a) => execFileSync(ADB, a).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function connect(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const pid = adb("shell", "pidof", PKG).split(/\s+/)[0];
      if (pid) {
        adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
        const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        const page = pages.find((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:8137"));
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
          let id = 0; const pending = new Map();
          ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
          const ev = (expr) => new Promise((r) => {
            const i = ++id; pending.set(i, r);
            ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } }));
          }).then((d) => d.result?.result?.value);
          return { ws, ev };
        }
      }
    } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error("WebView did not come up");
}

// True once the active story page shows a decoded panel and the reader bar is up.
const READY = `(() => {
  const vm = window.vm; if (!vm || !vm.$localData) return false;
  const tab = document.getElementById(vm.$localData.tabData.activeTabKey);
  const img = tab && tab.querySelector('.pageBody .media img');
  const bar = document.getElementById('uhcReaderBar');
  return !!(img && img.complete && img.naturalWidth && bar) && (performance.timeOrigin + performance.now());
})()`;

async function waitFor(ev, expr, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() > until) throw new Error("timeout waiting for " + expr.slice(0, 60));
    await sleep(15);
  }
}

// Put the reader on the start page so the cold start restores straight into a story page.
{
  const { ws, ev } = await connect();
  await waitFor(ev, `!!(window.vm && vm.$localData)`);
  await ev(`(vm.$pushURL(${JSON.stringify(START_PAGE)}), 1)`);
  // UHC saves its tabs after a 1 s debounce; wait until the start page is on disk.
  await waitFor(ev, `JSON.parse(localStorage.getItem('uhc-store:config')).tabData.tabs[vm.$localData.tabData.activeTabKey].url === ${JSON.stringify(START_PAGE)}`);
  await sleep(3000);   // the WebView writes localStorage to disk a moment later
  ws.close();
}

const cold = [], turns = [];
let heap = 0;
for (let run = 0; run < RUNS; run++) {
  adb("shell", "am", "force-stop", PKG);
  await sleep(800);
  const t0 = Number(adb("shell", "date", "+%s%3N"));
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  const { ws, ev } = await connect();
  const tReady = await waitFor(ev, READY);
  cold.push(Math.round(tReady - t0));

  // Page turns through the reader bar
  await sleep(500);
  for (let i = 0; i < TURNS; i++) {
    await sleep(300);   // mobile.js ignores a second tap within 250 ms (accidental double taps)
    const before = await ev(`vm.$localData.tabData.tabs[vm.$localData.tabData.activeTabKey].url`);
    const tTap = await ev(`(document.querySelector('#uhcReaderBar .uhc-next').click(), performance.timeOrigin + performance.now())`);
    await waitFor(ev, `vm.$localData.tabData.tabs[vm.$localData.tabData.activeTabKey].url !== ${JSON.stringify(before)}`);
    const tDone = await waitFor(ev, READY);
    turns.push(Math.round(tDone - tTap));
  }
  heap = await ev(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0`);
  await ev(`(vm.$pushURL(${JSON.stringify(START_PAGE)}), 1)`);
  await sleep(1500);
  ws.close();
  console.log(`run ${run + 1}: cold ${cold[run]} ms, turns ${turns.slice(-TURNS).join(" ")} ms`);
}
console.log(JSON.stringify({ coldStartMs: median(cold), pageTurnMs: median(turns), pageTurnP90Ms: [...turns].sort((a, b) => a - b)[Math.floor(turns.length * 0.9)], jsHeapMB: heap, runs: RUNS }));
