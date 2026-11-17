// A minimal fake browser for loading shim/uhc-shim.js in Node's vm, with an in-memory asset pack
// served through (sync) XMLHttpRequest and fetch, the same contract PackServer implements.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = fs.readFileSync(path.join(root, "shim", "uhc-shim.js"), "utf8");
const ORIGIN = "http://127.0.0.1:8137";

export function loadShim(packFiles = {}, { pathname = "/" } = {}) {
  const requests = [];

  function packLookup(url) {
    const u = new URL(url, ORIGIN);
    if (!u.pathname.startsWith("/pack/") && u.pathname !== "/pack") return { status: 404 };
    const rel = decodeURIComponent(u.pathname.slice(6)).replace(/\/$/, "");
    if (Object.prototype.hasOwnProperty.call(packFiles, rel)) return { status: 200, kind: "file", body: packFiles[rel] };
    const prefix = rel ? rel + "/" : "";
    const kids = new Map();
    for (const k of Object.keys(packFiles)) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf("/");
      kids.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
    }
    if (!kids.size) return { status: 404 };
    if (u.searchParams.has("list")) {
      return { status: 200, kind: "dir", body: JSON.stringify([...kids].map(([name, dir]) => ({ name, dir }))) };
    }
    return { status: 200, kind: "dir", body: "" };
  }

  class XMLHttpRequest {
    open(method, url, async) { this.method = method; this.url = url; this.async = async; }
    overrideMimeType() {}
    send() {
      requests.push(this.method + " " + this.url);
      const r = packLookup(this.url);
      this.status = r.status;
      this.responseText = this.method === "HEAD" ? "" : (r.body || "");
      this._kind = r.kind;
    }
    getResponseHeader(h) { return h === "X-UHC-Kind" ? this._kind || null : null; }
  }

  async function fetch(url) {
    const s = String(url);
    requests.push("FETCH " + s);
    const r = packLookup(s);
    return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body), text: async () => r.body };
  }

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // DOM classes the shim patches. Plain accessors stand in for the real IDL attributes.
  const proto = (names) => {
    const o = {};
    for (const n of names) {
      Object.defineProperty(o, n, {
        configurable: true, enumerable: true,
        get() { return this["_" + n]; }, set(v) { this["_" + n] = v; },
      });
    }
    return o;
  };
  class Element {
    constructor() { this.attrs = {}; this.nodeType = 1; }
    setAttribute(n, v) { this.attrs[n] = v; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  }
  const sub = (props) => { const C = class extends Element {}; Object.defineProperties(C.prototype, Object.getOwnPropertyDescriptors(proto(props))); return C; };
  const HTMLAnchorElement = sub(["href"]);
  const HTMLImageElement = sub(["src"]);
  const HTMLMediaElement = sub(["src"]);
  const HTMLVideoElement = class extends HTMLMediaElement {};
  Object.defineProperties(HTMLVideoElement.prototype, Object.getOwnPropertyDescriptors(proto(["poster"])));
  const HTMLIFrameElement = sub(["src", "srcdoc"]);
  class CSSStyleDeclaration {
    setProperty(p, v) { this[p] = v; }
  }
  Object.defineProperties(CSSStyleDeclaration.prototype, Object.getOwnPropertyDescriptors(proto(["background", "backgroundImage", "cssText"])));

  const window = {
    location: { origin: ORIGIN, pathname, port: "8137", reload() {} },
    localStorage, XMLHttpRequest, fetch,
    URL, URLSearchParams, TextEncoder, TextDecoder, Proxy, Promise, JSON, Math, Date, Error, Symbol, Object, Array,
    String, Number, Boolean, RegExp, Uint8Array, ArrayBuffer, Function,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    Element, HTMLAnchorElement, HTMLImageElement, HTMLMediaElement, HTMLVideoElement, HTMLIFrameElement,
    HTMLSourceElement: sub(["src"]), HTMLEmbedElement: sub(["src"]), HTMLObjectElement: sub(["data"]),
    HTMLScriptElement: sub(["src"]), HTMLLinkElement: sub(["href"]),
    CSSStyleDeclaration,
    MutationObserver: class { observe() {} },
    document: { documentElement: {}, title: "" },
    navigator: {},
  };
  window.Request = class { constructor(u) { this.url = u; } };
  window.window = window;
  window.self = window;
  const ctx = vm.createContext(window);
  vm.runInContext(SHIM, ctx, { filename: "uhc-shim.js" });
  return { window: ctx, requests, store, classes: { HTMLImageElement, HTMLAnchorElement, HTMLIFrameElement, CSSStyleDeclaration } };
}
