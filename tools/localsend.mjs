// Minimal LocalSend (protocol v2) sender, for pushing the APK and asset pack to a phone on the same Wi-Fi.
//
//   node tools/localsend.mjs discover
//   node tools/localsend.mjs send "<device name>" <file-or-folder>...
//
// Folders keep their structure (file names like "Asset Pack V2/archive/data/mspa.json").
// The phone shows an Accept prompt for each send unless LocalSend's "Quick Save" is on.
import dgram from "node:dgram";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MULTICAST = "224.0.0.167";
const PORT = 53317;
const ME = {
  alias: "Homestuck PC",
  version: "2.1",
  deviceModel: "Windows",
  deviceType: "desktop",
  fingerprint: crypto.randomBytes(16).toString("hex"),
  port: PORT,
  protocol: "https",
  download: false,
  announce: true,
};

function discover(seconds = 8) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (buf, rinfo) => {
      try {
        const d = JSON.parse(buf.toString());
        if (d.fingerprint === ME.fingerprint) return;
        found.set(d.alias, { ...d, ip: rinfo.address });
      } catch { /* not LocalSend */ }
    });
    sock.bind(PORT, () => {
      try { sock.addMembership(MULTICAST); } catch (e) { console.error("multicast join failed:", e.message); }
      const msg = Buffer.from(JSON.stringify(ME));
      const shout = () => sock.send(msg, PORT, MULTICAST);
      shout();
      const t = setInterval(shout, 2000);
      setTimeout(() => { clearInterval(t); sock.close(); resolve([...found.values()]); }, seconds * 1000);
    });
  });
}

// Fallback when multicast replies are blocked (e.g. by Windows Firewall): ask every address on the
// local /24 networks for LocalSend's info endpoint. Outgoing requests only.
async function scan() {
  const os = await import("node:os");
  const bases = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === "IPv4" && !a.internal && a.netmask === "255.255.255.0") bases.push(a.address.split(".").slice(0, 3).join("."));
  }
  const found = [];
  const probe = (ip, protocol) => request({ ip, port: PORT, protocol }, "GET", "/api/localsend/v2/info", null, {}, 1500)
    .then((r) => { if (r.status === 200) { const d = JSON.parse(r.body); found.push({ ...d, ip, protocol, port: PORT }); return true; } })
    .catch(() => false);
  await Promise.all(bases.flatMap((b) => Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`))
    .map(async (ip) => { if (!(await probe(ip, "https"))) await probe(ip, "http"); }));
  return found.filter((d) => d.fingerprint !== ME.fingerprint);
}

async function findDevices() {
  const viaMulticast = await discover();
  return viaMulticast.length ? viaMulticast : scan();
}

function request(dev, method, pathname, body, headers = {}, timeoutMs = 0) {
  const mod = dev.protocol === "http" ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: dev.ip, port: dev.port || PORT, method, path: pathname,
      rejectUnauthorized: false, headers, timeout: timeoutMs || undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body && typeof body.pipe === "function") body.pipe(req);
    else req.end(body);
  });
}

function collect(inputs) {
  const files = [];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel + "/" + name);
    } else if (st.isFile()) {
      files.push({ abs, rel, size: st.size });
    }
  };
  for (const input of inputs) walk(path.resolve(input), path.basename(path.resolve(input)));
  return files;
}

const TYPES = { apk: "application/vnd.android.package-archive", gif: "image/gif", png: "image/png", jpg: "image/jpeg",
  json: "application/json", txt: "text/plain", mp3: "audio/mpeg", mp4: "video/mp4", swf: "application/x-shockwave-flash" };

async function send(alias, inputs) {
  const devices = await findDevices();
  const dev = devices.find((d) => d.alias.toLowerCase() === alias.toLowerCase());
  if (!dev) {
    console.error(`Couldn't find "${alias}". Seen: ${devices.map((d) => d.alias).join(", ") || "nothing"}`);
    console.error("Open LocalSend on the phone (Receive tab) and make sure both are on the same Wi-Fi.");
    process.exit(2);
  }
  const files = collect(inputs);
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`Sending ${files.length} files (${(total / 1e9).toFixed(2)} GB) to ${dev.alias} at ${dev.ip}`);

  const manifest = {};
  files.forEach((f, i) => {
    f.id = "f" + i;
    const ext = path.extname(f.rel).slice(1).toLowerCase();
    manifest[f.id] = { id: f.id, fileName: f.rel, size: f.size, fileType: TYPES[ext] || "application/octet-stream" };
  });
  const info = { ...ME };
  delete info.announce;
  console.log("Waiting for you to tap Accept on the phone...");
  const prep = await request(dev, "POST", "/api/localsend/v2/prepare-upload",
    JSON.stringify({ info, files: manifest }), { "Content-Type": "application/json" }, 10 * 60 * 1000);
  if (prep.status === 204) { console.log("Phone says nothing to send."); return; }
  if (prep.status !== 200) { console.error("Phone declined or failed:", prep.status, prep.body); process.exit(3); }
  const { sessionId, files: tokens } = JSON.parse(prep.body);

  let done = 0, bytes = 0, failed = [];
  const started = Date.now();
  const queue = files.filter((f) => tokens[f.id]);
  const report = () => {
    const s = (Date.now() - started) / 1000;
    const rate = bytes / Math.max(s, 1);
    const left = (total - bytes) / Math.max(rate, 1);
    console.log(`  ${done}/${queue.length} files, ${(bytes / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB, ` +
      `${(rate / 1e6).toFixed(1)} MB/s, ~${Math.ceil(left / 60)} min left`);
  };
  const ticker = setInterval(report, 15000);

  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const q = `/api/localsend/v2/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${f.id}&token=${encodeURIComponent(tokens[f.id])}`;
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await request(dev, "POST", q, fs.createReadStream(f.abs),
            { "Content-Type": "application/octet-stream", "Content-Length": f.size }, 10 * 60 * 1000);
          if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.body}`);
          break;
        } catch (e) {
          if (attempt >= 3) { failed.push(f.rel + ": " + e.message); break; }
        }
      }
      done++; bytes += f.size;
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  clearInterval(ticker);
  report();
  if (failed.length) {
    console.error(`${failed.length} files failed:`);
    failed.slice(0, 20).forEach((x) => console.error("  " + x));
    process.exit(4);
  }
  console.log("Done.");
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "discover") {
  const d = await findDevices();
  if (!d.length) console.log("No LocalSend devices found.");
  d.forEach((x) => console.log(`${x.alias}  ${x.ip}:${x.port || PORT}  ${x.protocol}  ${x.deviceModel || ""}`));
} else if (cmd === "send" && args.length >= 2) {
  await send(args[0], args.slice(1));
} else {
  console.log('Usage: node tools/localsend.mjs discover | send "<device name>" <paths...>');
}
