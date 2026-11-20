// Copies the standard-library agents into ./agents so the packaged extension is self-contained.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const target = path.resolve(__dirname, "..", "agents");
const FOLDERS = ["agent-kit", "readability", "test-coverage", "performance", "maintainability", "scalability", "standards"];
const SKIP = new Set(["tests", "reports", "__pycache__"]);

fs.rmSync(target, { recursive: true, force: true });
for (const folder of FOLDERS) {
  fs.cpSync(path.join(repo, folder), path.join(target, folder), {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)) && !source.endsWith(".pyc"),
  });
}
console.log(`Bundled ${FOLDERS.length} agent folders into ${path.relative(process.cwd(), target) || "agents"}`);
