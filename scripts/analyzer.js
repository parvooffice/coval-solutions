import "dotenv/config";
import { spawn } from "node:child_process";

const python = process.env.CODE_EVALUATION_PYTHON || "python";
const port = process.env.ANALYZER_PORT || "8000";
const analyzer = spawn(python, ["-m", "uvicorn", "analyzer_service.app:app", "--host", "127.0.0.1", "--port", port], {
  stdio: "inherit",
  env: process.env,
});

analyzer.on("error", (error) => { console.error(`Unable to launch Python analyzer: ${error.message}`); process.exitCode = 1; });
analyzer.on("exit", (code) => { process.exitCode = code || 0; });
process.on("SIGINT", () => analyzer.kill("SIGINT"));
process.on("SIGTERM", () => analyzer.kill("SIGTERM"));
