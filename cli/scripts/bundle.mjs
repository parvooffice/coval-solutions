// Copies the shared pieces into the CLI so the published package is self-contained:
// the six local agents, the agent runner used by the VS Code extension, and the
// pull request comparison used by the COVAL GitHub App.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(cli, "..");
const AGENT_FOLDERS = ["agent-kit", "readability", "test-coverage", "performance", "maintainability", "scalability", "standards"];
const SKIP = new Set(["tests", "reports", "__pycache__"]);

fs.rmSync(path.join(cli, "agents"), { recursive: true, force: true });
for (const folder of AGENT_FOLDERS) {
  fs.cpSync(path.join(repo, folder), path.join(cli, "agents", folder), {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)) && !source.endsWith(".pyc"),
  });
}
fs.mkdirSync(path.join(cli, "lib"), { recursive: true });
fs.copyFileSync(path.join(repo, "ide-extension", "lib", "agents.js"), path.join(cli, "lib", "agents.cjs"));
fs.copyFileSync(path.join(repo, "app", "lib", "server", "pr-review.js"), path.join(cli, "lib", "pr-review.mjs"));
console.log("Bundled agents, runner (from the VS Code extension), and PR review (from the GitHub App).");
