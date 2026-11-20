"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { AGENTS, agentsRoot, findingsFrom, overall, parseLocation, scanWorkspace } = require("../lib/agents");

test("parses file:line locations", () => {
  assert.deepEqual(parseLocation("src/app.js:42"), { file: "src/app.js", line: 42 });
  assert.deepEqual(parseLocation("requirements.txt"), { file: "requirements.txt", line: null });
  assert.equal(parseLocation(""), null);
});

test("normalizes readability and test coverage reports", () => {
  const readability = findingsFrom("readability", { hotspots: [{ path: "a.py", line: 3, name: "run", length: 90, complexity: 20, nesting: 4 }] });
  assert.equal(readability[0].location, "a.py:3");
  const coverage = findingsFrom("test_coverage", { untested_modules: [{ path: "b.py", lines: 120 }] });
  assert.equal(coverage[0].location, "b.py");
  assert.deepEqual(findingsFrom("performance", { fixes: [{ title: "x" }] }), [{ title: "x" }]);
});

test("overall ignores failed agents", () => {
  assert.equal(overall([{ score: 80 }, { score: null }, { score: 60 }]), 70);
  assert.equal(overall([{ score: null }]), null);
});

test("scans a real folder with the bundled agents", { timeout: 240_000 }, async () => {
  const root = agentsRoot(path.resolve(__dirname, ".."));
  const workspace = path.join(root, "agent-kit");
  const result = await scanWorkspace({ python: process.env.COVAL_PYTHON || "python", root, workspace, enabled: [] });
  assert.equal(result.results.length, AGENTS.length);
  for (const agent of result.results) assert.ok(agent.score != null, `${agent.label} failed: ${agent.error}`);
  assert.ok(result.overall > 0);
});

test("reports a missing Python clearly", async () => {
  const root = agentsRoot(path.resolve(__dirname, ".."));
  const result = await scanWorkspace({ python: "definitely-not-python", root, workspace: root, enabled: ["performance"] });
  assert.match(result.results[0].error, /Python was not found/);
});
