// Copies the built engine (engine/dist/coval-engine.exe, from `node engine/build.mjs`)
// into ./bin so the Windows build of the extension runs without Python.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "..", "engine", "dist", "coval-engine.exe");
const target = path.resolve(__dirname, "..", "bin", "coval-engine.exe");
if (!fs.existsSync(source)) {
  console.error("engine/dist/coval-engine.exe is missing. Build it first: node engine/build.mjs");
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied the engine into ${path.relative(process.cwd(), target)}`);
