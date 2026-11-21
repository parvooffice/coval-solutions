// Builds engine/dist/coval-engine.exe: the six local agents plus Python in one file.
// Needs Python 3.10+ with PyInstaller (`python -m pip install pyinstaller`).
// Set COVAL_BUILD_PYTHON to use a different Python (for example a virtual environment).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(engine, "..");
const work = path.join(engine, "build");
const staging = path.join(work, "agents");
const AGENT_FOLDERS = ["agent-kit", "readability", "test-coverage", "performance", "maintainability", "scalability", "standards"];
const SKIP = new Set(["tests", "reports", "__pycache__"]);

fs.rmSync(work, { recursive: true, force: true });
for (const folder of AGENT_FOLDERS) {
  fs.cpSync(path.join(repo, folder), path.join(staging, folder), {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)) && !source.endsWith(".pyc"),
  });
}

const python = process.env.COVAL_BUILD_PYTHON || "python";
execFileSync(python, [
  "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--console",
  "--name", "coval-engine",
  "--distpath", path.join(engine, "dist"),
  "--workpath", path.join(work, "pyinstaller"),
  "--specpath", work,
  "--add-data", `${staging}${path.delimiter}agents`,
  path.join(engine, "coval_engine.py"),
], { stdio: "inherit" });

const exe = path.join(engine, "dist", process.platform === "win32" ? "coval-engine.exe" : "coval-engine");
console.log(`Built ${path.relative(repo, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
