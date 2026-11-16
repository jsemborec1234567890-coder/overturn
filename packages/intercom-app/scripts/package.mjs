// Assembles the uploadable Intercom Canvas Kit app bundle: manifest + built scripts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
cpSync(path.join(root, "dist", "main.js"), path.join(out, "main.js"));
cpSync(path.join(root, "dist", "capture.js"), path.join(out, "capture.js"));

try {
  rmSync(path.join(root, "dist", "overturn-intercom-app.zip"), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", "overturn-intercom-app.zip"), "."], { cwd: out });
  console.log("dist/overturn-intercom-app.zip");
} catch {
  console.log("dist/app (zip not available; package folder ready)");
}
