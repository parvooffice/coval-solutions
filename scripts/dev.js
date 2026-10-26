import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.NODE_ENV ||= "development";
process.env.CODE_EVALUATION_API_URL = process.env.COVAL_ANALYZER_URL || "http://127.0.0.1:8000/api/code-evaluation-python";
const { createServer } = await import("vite");
const configFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vite.config.js");
const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/index.js");
const apiServer = spawn(process.execPath, ["--watch", serverEntry], { stdio: "inherit", env: process.env });
const vite = await createServer({ configFile });
await vite.listen();
vite.printUrls();

async function shutdown() {
  await vite.close();
  apiServer.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
apiServer.on("exit", (code) => { if (code && code !== 0) process.exit(code); });
