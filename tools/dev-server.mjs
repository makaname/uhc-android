// Serves the app the same way the Android WebView will, for testing in a desktop browser.
//   http://127.0.0.1:8137/        -> build/web
//   http://127.0.0.1:8137/pack/   -> the asset pack (Range, HEAD with X-UHC-Kind, ?list=1)
// Usage: node tools/dev-server.mjs "<path to Asset Pack V2>"
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(root, "build", "assets", "web");
const PACK = path.resolve(process.argv[2] || path.join(root, "..", "Asset Pack V2 - The Unofficial Homestuck Collection", "Asset Pack V2"));
const PORT = 8137;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp", ".swf": "application/x-shockwave-flash",
  ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4",
  ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject"
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Access-Control-Allow-Origin": "*", ...headers });
  res.end(body);
}

function serveFile(req, res, file, base) {
  if (!file.startsWith(base)) return send(res, 403, "forbidden");
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, "not found"); }

  if (st.isDirectory()) {
    if (req.method === "HEAD") return send(res, 200, null, { "X-UHC-Kind": "dir" });
    if (new URL(req.url, "http://x").searchParams.has("list")) {
      const list = fs.readdirSync(file, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() }));
      return send(res, 200, JSON.stringify(list), { "Content-Type": TYPES[".json"] });
    }
    const index = path.join(file, "index.html");
    if (fs.existsSync(index)) return serveFile(req, res, index, base);
    return send(res, 404, "not found");
  }

  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "X-UHC-Kind": "file", "Cache-Control": "no-cache" };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { "Access-Control-Allow-Origin": "*", ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Access-Control-Allow-Origin": "*", ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/pack" || pathname.startsWith("/pack/")) {
    return serveFile(req, res, path.join(PACK, pathname.slice(5)), PACK);
  }
  // Single-page app: unknown routes fall back to index.html
  let file = path.join(WEB, pathname);
  if (!fs.existsSync(file)) file = path.join(WEB, "index.html");
  serveFile(req, res, file, WEB);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`UHC dev server: http://127.0.0.1:${PORT}/  (pack: ${PACK})`);
});
