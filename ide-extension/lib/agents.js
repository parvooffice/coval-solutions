// Editor-independent core of the COVAL extension: which agents run, how to run them,
// and how their JSON reports become scores and line-level findings. No `vscode` import,
// so it can be tested with plain Node.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const AGENTS = [
  { id: "readability", label: "Readability", dir: "readability", script: "readability_scorer.py" },
  { id: "test_coverage", label: "Test coverage", dir: "test-coverage", script: "test_coverage_scorer.py" },
  { id: "performance", label: "Performance", dir: "performance", script: "performance_scorer.py" },
  { id: "maintainability", label: "Maintainability", dir: "maintainability", script: "maintainability_scorer.py" },
  { id: "scalability", label: "Scalability", dir: "scalability", script: "scalability_scorer.py" },
  { id: "standards", label: "Standards compliance", dir: "standards", script: "standards_scorer.py" },
];

// Packaged extensions ship the agents in ./agents; when developing from the repo, use the repo root.
function agentsRoot(extensionDir) {
  const bundled = path.join(extensionDir, "agents");
  return fs.existsSync(path.join(bundled, "agent-kit")) ? bundled : path.resolve(extensionDir, "..");
}

function grade(score) {
  if (score == null) return "";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// "src/app.js:42" → { file: "src/app.js", line: 42 }; "requirements.txt" → { file, line: null }.
function parseLocation(location) {
  if (!location || typeof location !== "string") return null;
  const match = location.match(/^(.*?):(\d+)$/);
  return match ? { file: match[1], line: Number(match[2]) } : { file: location, line: null };
}

// Normalize the three report styles (agent-kit `fixes`, readability `hotspots`, test coverage `untested_modules`).
function findingsFrom(agentId, report) {
  if (Array.isArray(report.fixes) && report.fixes.length) return report.fixes.map((fix) => ({ ...fix }));
  if (agentId === "readability") {
    return (report.hotspots || []).map((item) => ({
      title: `Simplify ${item.name || "this function"}`,
      location: `${item.path}:${item.line}`,
      detail: `${item.length} lines, ${item.complexity} decision points, nesting depth ${item.nesting}.`,
    }));
  }
  if (agentId === "test_coverage") {
    return (report.untested_modules || []).map((item) => ({ title: "Add tests for this module", location: item.path, detail: `${item.lines} lines with no matching test.` }));
  }
  return [];
}

function summarize(agent, report) {
  const score = report?.final_score?.score ?? null;
  return {
    id: agent.id,
    label: agent.label,
    score,
    grade: report?.final_score?.grade || grade(score),
    summary: report?.summary || "",
    categories: Object.entries(report?.categories || {}).map(([key, value]) => ({ key, label: value.label || key, score: value.score, detail: value.detail || "" })),
    findings: findingsFrom(agent.id, report || {}).map((finding) => ({ ...finding, agent: agent.label, position: parseLocation(finding.location) })),
  };
}

function overall(results) {
  const scores = results.filter((item) => item.score != null).map((item) => item.score);
  return scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : null;
}

function runAgent({ python, root, agent, workspace, timeoutMs = 180_000 }) {
  const output = path.join(os.tmpdir(), `coval-${agent.id}-${process.pid}-${Date.now()}.json`);
  const script = path.join(root, agent.dir, agent.script);
  return new Promise((resolve) => {
    execFile(python, [script, workspace, "--output", output, "--quiet"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      let report = null;
      try { report = JSON.parse(fs.readFileSync(output, "utf8")); } catch { /* reported below */ }
      fs.rm(output, { force: true }, () => {});
      if (report) return resolve(summarize(agent, report));
      const reason = error?.code === "ENOENT"
        ? `Python was not found at "${python}". Set "coval.pythonPath" in settings.`
        : (stderr || error?.message || "The agent did not produce a report.").trim().split("\n").slice(-3).join(" ");
      resolve(failedResult(agent, reason));
    });
  });
}

// The packaged engine (coval-engine.exe) bundles Python and the agents in one file.
// Look for it in <base>/bin, or use COVAL_ENGINE; without it, fall back to Python.
function findEngine(...baseDirs) {
  const name = process.platform === "win32" ? "coval-engine.exe" : "coval-engine";
  const candidates = [process.env.COVAL_ENGINE, ...baseDirs.filter(Boolean).map((dir) => path.join(dir, "bin", name))];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function failedResult(agent, reason) {
  return { id: agent.id, label: agent.label, score: null, grade: "", summary: "", categories: [], findings: [], error: reason };
}

function runEngine({ engine, agents, workspace, timeoutMs = 300_000 }) {
  const output = path.join(os.tmpdir(), `coval-engine-${process.pid}-${Date.now()}.json`);
  const args = ["scan", workspace, "--agents", agents.map((agent) => agent.id).join(","), "--output", output];
  return new Promise((resolve) => {
    execFile(engine, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(output, "utf8")); } catch { /* reported below */ }
      fs.rm(output, { force: true }, () => {});
      if (!payload) {
        const reason = (stderr || error?.message || "The COVAL engine did not produce a result.").trim().split("\n").slice(-3).join(" ");
        return resolve(agents.map((agent) => failedResult(agent, reason)));
      }
      resolve(agents.map((agent) => (payload.reports?.[agent.id]
        ? summarize(agent, payload.reports[agent.id])
        : failedResult(agent, payload.errors?.[agent.id] || "The agent did not produce a report."))));
    });
  });
}

async function scanWorkspace({ engine, python, root, workspace, enabled }) {
  const agents = AGENTS.filter((agent) => !enabled?.length || enabled.includes(agent.id));
  const results = engine
    ? await runEngine({ engine, agents, workspace })
    : await Promise.all(agents.map((agent) => runAgent({ python, root, agent, workspace })));
  return { workspace, results, overall: overall(results), scannedAt: new Date().toISOString(), runner: engine ? "engine" : "python" };
}

module.exports = { AGENTS, agentsRoot, findEngine, grade, parseLocation, findingsFrom, summarize, overall, runAgent, runEngine, scanWorkspace };
