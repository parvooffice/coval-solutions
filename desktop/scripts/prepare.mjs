// Gathers what the desktop app ships with: the engine (engine/dist, from `node engine/build.mjs`),
// the agent runner shared with the VS Code extension, and the coval CLI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktop, "..");
const engine = path.join(repo, "engine", "dist", "coval-engine.exe");
if (!fs.existsSync(engine)) {
  console.error("engine/dist/coval-engine.exe is missing. Build it first: node engine/build.mjs");
  process.exit(1);
}

fs.rmSync(path.join(desktop, "resources"), { recursive: true, force: true });
fs.mkdirSync(path.join(desktop, "resources", "bin"), { recursive: true });
fs.copyFileSync(engine, path.join(desktop, "resources", "bin", "coval-engine.exe"));

fs.mkdirSync(path.join(desktop, "lib"), { recursive: true });
fs.copyFileSync(path.join(repo, "ide-extension", "lib", "agents.js"), path.join(desktop, "lib", "agents.js"));

execFileSync(process.execPath, [path.join(repo, "cli", "scripts", "bundle.mjs")], { stdio: "inherit" });
const cliTarget = path.join(desktop, "resources", "cli");
for (const item of ["bin", "lib", "package.json"]) {
  fs.cpSync(path.join(repo, "cli", item), path.join(cliTarget, item), { recursive: true });
}
console.log("Prepared the engine, the agent runner, and the CLI for the desktop app.");
