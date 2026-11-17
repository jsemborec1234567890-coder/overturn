// Assembles the uploadable Front plugin: manifest + html + styles + built script into dist/app and dist/*.zip

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(path.join(out, "assets"), { recursive: true });

// Copy app static assets
cpSync(path.join(root, "app"), out, { recursive: true });

// Copy built bundle to both root main.js and assets/main.js
const bundledScript = path.join(root, "dist", "main.global.js");
if (existsSync(bundledScript)) {
  cpSync(bundledScript, path.join(out, "main.js"));
  cpSync(bundledScript, path.join(out, "assets", "main.js"));
}

const zip = (name) => {
  const target = path.join(root, "dist", name);
  rmSync(target, { force: true });

  // 1. Try standard unix zip
  try {
    execFileSync("zip", ["-qr", target, "."], { cwd: out });
    console.log(`dist/${name}`);
    return;
  } catch {
    // zip not installed or not in PATH
  }

  // 2. Try tar on Windows/modern systems (supports -a -cf for zip creation)
  try {
    execSync(`tar -a -cf "${target}" *`, { cwd: out, stdio: "ignore" });
    if (existsSync(target)) {
      console.log(`dist/${name}`);
      return;
    }
  } catch {
    // tar not available or failed
  }

  // 3. Try PowerShell Compress-Archive on Windows
  try {
    execSync(
      `powershell.exe -NoProfile -Command "Compress-Archive -Path '${out}/*' -DestinationPath '${target}'"`,
      {
        stdio: "ignore",
      },
    );
    if (existsSync(target)) {
      console.log(`dist/${name}`);
      return;
    }
  } catch {
    // powershell fallback failed
  }

  console.log(`dist/app (zip tool not found; upload the directory directly)`);
};

zip("overturn-front-plugin.zip");
