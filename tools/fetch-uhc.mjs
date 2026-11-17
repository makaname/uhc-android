// Gets the compiled UHC 2.8.1 UI bundle into vendor/uhc-2.8.1-app/ from the official Windows installer.
// The bundle isn't committed; this recreates it exactly (the installer is checked against a SHA-256).
//
//   node tools/fetch-uhc.mjs                      downloads the installer from the official GitHub release
//   node tools/fetch-uhc.mjs <path-to-installer>  uses a copy you already have
//
// Needs 7-Zip on PATH as "7z" (Windows: scoop install 7zip; Ubuntu: apt install p7zip-full).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INSTALLER_URL = "https://github.com/GiovanH/unofficial-homestuck-collection/releases/download/v2.8.1/The-Unofficial-Homestuck-Collection-2.8.1-win-x64.exe";
const INSTALLER_SHA256 = "130cd0d6d262697d17fabdb05c7f5d09ae816f5d42e0f92dceb071fb50b9352e";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "vendor", "uhc-2.8.1-app");
const work = path.join(root, "build", "fetch-uhc");

if (fs.existsSync(path.join(out, "index.html")) && !process.argv.includes("--force")) {
  console.log("vendor/uhc-2.8.1-app already present (use --force to redo).");
  process.exit(0);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

let installer = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!installer) {
  installer = path.join(work, "uhc-2.8.1-win-x64.exe");
  console.log("Downloading", INSTALLER_URL);
  const res = await fetch(INSTALLER_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(installer, Buffer.from(await res.arrayBuffer()));
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(installer)).digest("hex");
if (hash !== INSTALLER_SHA256) throw new Error(`Installer checksum mismatch:\n  got      ${hash}\n  expected ${INSTALLER_SHA256}`);
console.log("Installer verified.");

const sevenZip = (...args) => execFileSync("7z", args, { stdio: ["ignore", "ignore", "inherit"] });
sevenZip("e", "-y", installer, "$PLUGINSDIR/app-64.7z", `-o${work}`);
sevenZip("x", "-y", path.join(work, "app-64.7z"), "resources/app.asar", `-o${work}`);

fs.rmSync(out, { recursive: true, force: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["--yes", "@electron/asar@3.2.17", "extract", path.join(work, "resources", "app.asar"), out],
  { stdio: "inherit", shell: process.platform === "win32" });
fs.rmSync(path.join(out, "node_modules"), { recursive: true, force: true }); // desktop-only; the shim replaces it
fs.rmSync(work, { recursive: true, force: true });

console.log("vendor/uhc-2.8.1-app ready.");
