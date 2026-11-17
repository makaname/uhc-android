// Extracts original source files from the inline source maps embedded in the UHC webpack bundle.
// Usage: node extract-sources.js <bundle js dir> <out dir>
const fs = require("fs");
const path = require("path");
const [dir, out] = process.argv.slice(2);
const re = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/g;
let n = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
  const t = fs.readFileSync(path.join(dir, f), "utf8");
  for (const m of t.matchAll(re)) {
    let map;
    try { map = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { continue; }
    (map.sources || []).forEach((src, i) => {
      const content = map.sourcesContent && map.sourcesContent[i];
      if (!content) return;
      let rel = src.replace(/^webpack:\/\/\//, "").replace(/\?[0-9a-f]+$/, "").replace(/[?*:<>|"]/g, "_");
      if (rel.includes("node_modules") || rel.startsWith("external ")) return;
      const dest = path.join(out, rel);
      if (!dest.startsWith(path.resolve(out))) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) { fs.writeFileSync(dest, content); n++; }
    });
  }
}
console.log("wrote", n, "files");
