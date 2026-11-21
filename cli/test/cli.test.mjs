import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "coval.mjs");
const run = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 240_000 });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coval-cli-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "COVAL test");
  fs.writeFileSync(path.join(dir, "app.js"), "export function add(first, second) {\n  return first + second;\n}\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return dir;
}

test("prints help and version", () => {
  assert.match(run(["--help"]).stdout, /coval review/);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
});

test("scan scores a folder as JSON", () => {
  const dir = makeRepo();
  const result = run(["scan", dir, "--json", "--agents", "performance,scalability"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.results.length, 2);
  assert.ok(report.overall > 0);
});

test("review flags a new network call without a timeout and can fail the build", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "client.js"), "export async function load(ids) {\n  for (const id of ids) {\n    await fetch('http://localhost:4000/items/' + id);\n  }\n}\n");
  const result = run(["review", "--base", "main", "--agents", "performance,scalability", "--markdown", "--fail-on-drop", "0"], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /COVAL code review/);
  assert.match(result.stdout, /Network call without a timeout/);
  assert.match(result.stderr, /dropped/);
});
