// Tests for shim/uhc-shim.js: path, the electron-store stand-in, fs, fixUrl and the CommonJS loader.
// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { loadShim } from "./shim-env.mjs";

const PACK = {
  "archive/data/version.json": '{"version":"2.0"}',
  "archive/data/mspa.json": '{"story":{}}',
  "archive/data/social.json": "{}", "archive/data/news.json": "{}", "archive/data/music.json": "{}",
  "archive/data/comics.json": "{}", "archive/data/extras.json": "{}", "archive/data/tweaks.json": "{}",
  "storyfiles/hs2/00001.gif": "GIF89a",
  "archive/imods/demo/mod.js": "const h = require('./helper'); const d = require('./data.json'); module.exports = { title: h.name + d.n, dir: __dirname };",
  "archive/imods/demo/helper.js": "exports.name = 'demo'; exports.loads = (exports.loads || 0) + 1;",
  "archive/imods/demo/data.json": '{"n": 1}',
  "archive/imods/demo/big.yaml": "a: 1\n",
  "archive/imods/broken/mod.js": "throw new Error('boom')",
};

test("path behaves like posix path", () => {
  const { window } = loadShim(PACK);
  const p = window.require("path");
  assert.equal(p.join("/pack", "archive", "..", "storyfiles", "x.gif"), "/pack/storyfiles/x.gif");
  assert.equal(p.join("a", "", "b/"), "a/b/");
  assert.equal(p.join(), ".");
  assert.equal(p.normalize("a\\b\\..\\c"), "a/c");
  assert.equal(p.normalize("../x/./y"), "../x/y");
  assert.equal(p.resolve("/pack/mods", "./demo", "mod.js"), "/pack/mods/demo/mod.js");
  assert.equal(p.resolve("/a", "/b", "c"), "/b/c");
  assert.equal(p.dirname("/pack/a/b.js"), "/pack/a");
  assert.equal(p.dirname("/x"), "/");
  assert.equal(p.basename("/pack/a/b.js", ".js"), "b");
  assert.equal(p.extname("/a/b.tar.gz"), ".gz");
  assert.equal(p.extname("/a/.hidden"), "");
  assert.equal(p.relative("/pack/a/b", "/pack/c"), "../../c");
  assert.deepEqual({ ...p.parse("/a/b.txt") }, { root: "/", dir: "/a", base: "b.txt", ext: ".txt", name: "b" });
  assert.equal(p.isAbsolute("/x"), true);
  assert.equal(p.posix, p);
});

test("electron-store keeps settings in localStorage", () => {
  const { window, store } = loadShim(PACK);
  const Store = window.require("electron-store");
  const s = new Store({ defaults: { a: 1, nested: { b: 2 } } });
  assert.equal(s.get("a"), 1);
  assert.equal(s.get("nested.b"), 2);
  assert.equal(s.get("missing", "dflt"), "dflt");
  assert.equal(s.get("assetDir"), "/pack");                   // the pack always lives at /pack
  assert.equal(s.get("settings.ruffleFallback"), true);       // no Flash plugin on Android
  s.set("nested.c.d", 5);
  s.set({ x: [1, 2] });
  assert.equal(s.get("nested.c.d"), 5);
  assert.deepEqual([...s.get("x")], [1, 2]);
  assert.equal(s.has("x"), true);
  s.delete("x");
  assert.equal(s.has("x"), false);
  // Values are copies, and persist across instances
  const got = s.get("nested");
  got.b = 99;
  assert.equal(new Store().get("nested.b"), 2);
  assert.ok(store.get("uhc-store:config").includes('"nested"'));
  // A separately named store is separate
  const other = new Store({ name: "other" });
  other.set("k", "v");
  assert.equal(new Store().get("k"), undefined);
  assert.equal(other.path, "/userdata/other.json");
});

test("electron-store survives corrupt saved data", () => {
  const { window, store } = loadShim(PACK);
  store.set("uhc-store:config", "{not json");
  const s = new (window.require("electron-store"))();
  assert.equal(s.get("assetDir"), "/pack");
});

test("fs reads the pack over sync XHR and caches text", () => {
  const { window, requests } = loadShim(PACK);
  const fs = window.require("fs");
  assert.equal(fs.existsSync("/pack/storyfiles/hs2/00001.gif"), true);
  assert.equal(fs.existsSync("/pack/nope.gif"), false);
  assert.equal(fs.existsSync("/etc/passwd"), false);            // outside the pack
  assert.equal(fs.statSync("/pack/archive").isDirectory(), true);
  assert.throws(() => fs.statSync("/pack/nope"), { code: "ENOENT" });
  assert.deepEqual([...fs.readdirSync("/pack/archive/imods")].sort(), ["broken", "demo"]);
  const dirents = fs.readdirSync("/pack/archive/imods/demo", { withFileTypes: true });
  assert.equal(dirents.find((d) => d.name === "mod.js").isFile(), true);

  const bin = fs.readFileSync("/pack/storyfiles/hs2/00001.gif");
  assert.equal(bin.toString(), "GIF89a");
  assert.equal(window.Buffer.isBuffer(bin), true);

  const before = requests.length;
  assert.equal(fs.readFileSync("/pack/archive/imods/demo/big.yaml", "utf8"), "a: 1\n");
  assert.equal(fs.readFileSync("/pack/archive/imods/demo/big.yaml", { encoding: "utf8" }), "a: 1\n");
  assert.equal(requests.length - before, 1, "second text read comes from the cache");
});

test("fs callback and promise forms report errors", async () => {
  const { window } = loadShim(PACK);
  const fs = window.require("fs");
  await assert.rejects(fs.promises.readFile("/pack/missing.txt", "utf8"), { code: "ENOENT" });
  assert.equal(await fs.promises.readFile("/pack/archive/data/version.json", "utf8"), '{"version":"2.0"}');
  await new Promise((resolve) => fs.readFile("/pack/missing.txt", "utf8", (err) => { assert.equal(err.code, "ENOENT"); resolve(); }));
});

test("fixUrl maps assets:// and old URLs into the pack", () => {
  const { window } = loadShim(PACK);
  const { fixUrl, PACK_URL } = window.UHCShim;
  assert.equal(PACK_URL, "http://127.0.0.1:8137/pack/");
  assert.equal(fixUrl("assets://storyfiles/hs2/00001.gif"), "http://127.0.0.1:8137/pack/storyfiles/hs2/00001.gif");
  assert.equal(fixUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(fixUrl(undefined), undefined);

  // Once UHC publishes window.Resources, its resolver is used, and pack URLs pass through it untouched.
  window.Resources = {
    isReady: () => true,
    resolveAssetsProtocol: (u) => "R:" + u,
    resolveURL: (u) => "U:" + u,
  };
  assert.equal(fixUrl("assets://x.gif"), "R:assets://x.gif");
  assert.equal(fixUrl("http://www.mspaintadventures.com/storyfiles/x.gif"), "U:http://www.mspaintadventures.com/storyfiles/x.gif");
  assert.equal(window.Resources.resolveURL("http://127.0.0.1:8137/pack/a.gif"), "http://127.0.0.1:8137/pack/a.gif");
  assert.equal(window.Resources.getResourceURL, window.Resources.resolveURL);
});

test("DOM setters and CSS rewrite assets:// URLs", () => {
  const { classes } = loadShim(PACK);
  const img = new classes.HTMLImageElement();
  img.src = "assets://images/a.png";
  assert.equal(img.src, "http://127.0.0.1:8137/pack/images/a.png");
  img.setAttribute("src", "assets://images/b.png");
  assert.equal(img.getAttribute("src"), "http://127.0.0.1:8137/pack/images/b.png");
  img.setAttribute("style", "background: url(assets://images/c.png)");
  assert.equal(img.getAttribute("style"), "background: url(http://127.0.0.1:8137/pack/images/c.png)");
  const a = new classes.HTMLAnchorElement();
  a.setAttribute("href", "assets://keep.html");                 // links are left for the router
  assert.equal(a.getAttribute("href"), "assets://keep.html");
  const style = new classes.CSSStyleDeclaration();
  style.backgroundImage = "url(assets://bg.png)";
  assert.equal(style.backgroundImage, "url(http://127.0.0.1:8137/pack/bg.png)");
  const frame = new classes.HTMLIFrameElement();
  frame.srcdoc = "<p>flash</p>";
  assert.match(frame.srcdoc, /UHCShim\.patchNetwork\(window\).*<p>flash<\/p>$/);
  const hooked = frame.srcdoc;
  frame.srcdoc = hooked;                                        // not hooked twice
  assert.equal(frame.srcdoc.match(/patchNetwork/g).length, 1);
});

test("CommonJS loader runs pack modules with relative requires", () => {
  const { window } = loadShim(PACK);
  const mod = window.require("/pack/archive/imods/demo/mod.js");
  assert.equal(mod.title, "demo1");
  assert.equal(mod.dir, "/pack/archive/imods/demo");
  // Cached like Node: the helper ran once
  const helper = window.require("/pack/archive/imods/demo/helper");
  assert.equal(helper.loads, 1);
  assert.ok(window.require.cache["/pack/archive/imods/demo/helper.js"]);
  // Folder require resolves index.js; missing files throw ENOENT
  assert.throws(() => window.require("/pack/archive/imods/nothing"), { code: "ENOENT" });
  // A module that throws is not cached, so a retry runs it again
  assert.throws(() => window.require("/pack/archive/imods/broken/mod.js"), /boom/);
  assert.equal(window.require.cache["/pack/archive/imods/broken/mod.js"], undefined);
  // Built-in modules and stubs
  assert.equal(window.require("electron").ipcRenderer, window.UHCShim.ipcRenderer);
  assert.equal(typeof window.require("crypto").createHash, "function");  // tolerant stub
});

test("archive JSON is prefetched once and handed to the app on load", async () => {
  const { window, requests } = loadShim(PACK);
  assert.ok(requests.includes("FETCH http://127.0.0.1:8137/pack/archive/data/mspa.json"), "prefetch starts at load");
  const ipc = window.UHCShim.ipcRenderer;
  const archive = await new Promise((resolve, reject) => {
    ipc.on("ARCHIVE_UPDATE", (_e, data) => resolve(data));
    ipc.on("SET_LOAD_ERROR", (_e, err) => reject(new Error(err)));
    ipc.send("RELOAD_ARCHIVE_DATA");
  });
  assert.equal(archive.version, "2.0");
  assert.deepEqual({ ...archive.mspa }, { story: {} });
  assert.equal(requests.filter((r) => r.endsWith("/mspa.json")).length, 1, "prefetch reused");
  // A second load (after mods change) fetches fresh objects
  await new Promise((resolve) => { ipc.once("ARCHIVE_UPDATE", resolve); ipc.send("RELOAD_ARCHIVE_DATA"); });
  assert.equal(requests.filter((r) => r.endsWith("/mspa.json")).length, 2);
});

test("the setup page does not prefetch the archive", () => {
  const { requests } = loadShim(PACK, { pathname: "/__setup/index.html" });
  assert.equal(requests.length, 0);
});

test("a missing pack reports a load error", async () => {
  const { window } = loadShim({});
  const ipc = window.UHCShim.ipcRenderer;
  const err = await new Promise((resolve) => { ipc.on("SET_LOAD_ERROR", (_e, e) => resolve(JSON.parse(e))); ipc.send("RELOAD_ARCHIVE_DATA"); });
  assert.match(err.message, /Could not load archive\/data\/version\.json/);
});
