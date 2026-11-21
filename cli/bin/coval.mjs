#!/usr/bin/env node
// COVAL CLI: `coval scan` scores a folder; `coval review` compares a branch with its base,
// the same way the COVAL GitHub App reviews pull requests, and can post the comment.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8")).version;

function loadShared() {
  const runner = path.join(cliRoot, "lib", "agents.cjs");
  const review = path.join(cliRoot, "lib", "pr-review.mjs");
  if (!fs.existsSync(runner) || !fs.existsSync(review)) {
    fail("The CLI is not bundled yet. Run `npm run bundle` in the cli folder (published packages include it).");
  }
  return { agents: require(runner), reviewModule: import(pathToFileURL(review).href) };
}

const HELP = `COVAL CLI ${VERSION}

Usage:
  coval scan [path] [--json] [--agents a,b]
      Score a folder with COVAL's local agents (default: current folder).

  coval review [--base <ref>] [--head <ref>] [--path <repo>] [--markdown]
               [--comment --repo <owner/name> --pr <number>]
               [--fail-under <score>] [--fail-on-drop <points>]
      Review a branch like a pull request: scores the base ref and your code
      (the working tree, or --head), then shows score changes and new findings.
      --comment posts or updates the COVAL comment on the pull request
      (needs GITHUB_TOKEN; --repo and --pr are detected in GitHub Actions).
      --fail-under / --fail-on-drop exit with code 2 to block a merge.

Options:
  --python <cmd>   Run the agents with this Python 3.10+ instead of the bundled
                   COVAL engine (default when no engine: COVAL_PYTHON or python)
  --version, --help

The CLI, the VS Code extension, and the COVAL GitHub App share the same agents and
review format. The web app adds four more agents and AI explanations.`;

function fail(message, code = 1) {
  process.stderr.write(`coval: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const [key, inline] = item.slice(2).split("=", 2);
    if (["json", "markdown", "comment", "help", "version"].includes(key)) args[key] = true;
    else args[key] = inline ?? argv[++index];
  }
  return args;
}

const color = (code, text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const fmt = (value) => (value == null ? "—" : Number(value).toFixed(1).replace(/\.0$/, ""));
const gradeColor = (score) => (score == null ? 90 : score >= 70 ? 32 : score >= 55 ? 33 : 31);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function scan(agents, workspace, options) {
  const root = agents.agentsRoot(cliRoot);
  const enabled = options.agents ? String(options.agents).split(",").map((item) => item.trim()) : [];
  // Prefer the packaged engine (bundled by the COVAL desktop app, or COVAL_ENGINE); --python forces Python.
  const engine = options.python ? null : agents.findEngine(cliRoot, process.env.COVAL_HOME);
  const result = await agents.scanWorkspace({ engine, python: options.python || process.env.COVAL_PYTHON || "python", root, workspace, enabled });
  const failures = result.results.filter((item) => item.error);
  if (failures.length === result.results.length) fail(failures[0].error);
  for (const item of failures) process.stderr.write(color(33, `warning: ${item.label} did not run: ${item.error}\n`));
  return result;
}

// Same shape the GitHub App compares, so the CLI and PR comments agree.
const asTarget = (result) => ({
  evaluations: result.results.map((item) => ({ id: item.id, label: item.label, status: item.error ? "failed" : "complete", score: item.score, fixes: item.findings })),
});

function printScan(result) {
  console.log(`\n${color(1, "COVAL")}  ${path.basename(result.workspace)}  overall ${color(gradeColor(result.overall), fmt(result.overall))}\n`);
  for (const item of [...result.results].sort((a, b) => (a.score ?? -1) - (b.score ?? -1))) {
    const score = item.error ? color(31, "failed") : `${color(gradeColor(item.score), fmt(item.score).padStart(5))}  ${item.grade}`;
    console.log(`  ${item.label.padEnd(22)} ${score}`);
    for (const finding of item.findings.slice(0, 3)) console.log(color(90, `      • ${finding.title}${finding.location ? `  (${finding.location})` : ""}`));
  }
  console.log("");
}

async function postComment(markdown, options, reviewModule) {
  const token = process.env.GITHUB_TOKEN;
  let repo = options.repo || process.env.GITHUB_REPOSITORY;
  let pr = options.pr;
  if (!pr && process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    pr = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request?.number;
  }
  if (!token || !repo || !pr) fail("--comment needs GITHUB_TOKEN plus --repo owner/name and --pr number (detected automatically in GitHub Actions).");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "coval-cli", "Content-Type": "application/json" };
  const base = `https://api.github.com/repos/${repo}/issues`;
  const list = await fetch(`${base}/${pr}/comments?per_page=100`, { headers, signal: AbortSignal.timeout(15_000) });
  const existing = list.ok ? (await list.json()).find((comment) => comment.body?.includes(reviewModule.COMMENT_MARKER)) : null;
  const response = await fetch(existing ? `${base}/comments/${existing.id}` : `${base}/${pr}/comments`, {
    method: existing ? "PATCH" : "POST", headers, body: JSON.stringify({ body: markdown }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail(`GitHub rejected the comment (HTTP ${response.status}).`);
  console.log(`${existing ? "Updated" : "Posted"} the COVAL review on ${repo}#${pr}.`);
}

async function review(agents, reviewModule, options) {
  const repoPath = path.resolve(options.path || process.cwd());
  let top;
  try { top = git(repoPath, ["rev-parse", "--show-toplevel"]); } catch { fail(`${repoPath} is not a Git repository.`); }
  const baseRef = options.base || process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}` || "main";
  try { git(top, ["rev-parse", "--verify", `${baseRef}^{commit}`]); } catch { fail(`Cannot find base ref "${baseRef}". Fetch it first or pass --base.`); }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "coval-review-"));
  const worktrees = [];
  const checkout = (ref, name) => {
    const target = path.join(temp, name);
    git(top, ["worktree", "add", "--detach", "--quiet", target, ref]);
    worktrees.push(target);
    return target;
  };
  try {
    process.stderr.write(`Scoring ${baseRef} and ${options.head || "your working tree"}…\n`);
    const baseDir = checkout(baseRef, "base");
    const headDir = options.head ? checkout(options.head, "head") : top;
    const [baseResult, headResult] = await Promise.all([scan(agents, baseDir, options), scan(agents, headDir, options)]);
    const comparison = reviewModule.compareTargets(asTarget(baseResult), asTarget(headResult));
    const headSha = options.head ? git(top, ["rev-parse", options.head]) : git(top, ["rev-parse", "HEAD"]);
    let repoUrl = "";
    try { repoUrl = git(top, ["remote", "get-url", "origin"]).replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, ""); } catch { /* no remote */ }
    const markdown = reviewModule.renderComment(comparison, { repoUrl: repoUrl || "https://github.com", headSha, appUrl: "" });

    if (options.markdown || options.comment) console.log(markdown);
    else printReview(comparison, baseRef);
    if (options.comment) await postComment(markdown, options, reviewModule);

    const drop = comparison.headOverall != null && comparison.baseOverall != null ? comparison.baseOverall - comparison.headOverall : 0;
    if (options["fail-under"] != null && (comparison.headOverall ?? 0) < Number(options["fail-under"])) fail(`Overall score ${fmt(comparison.headOverall)} is below ${options["fail-under"]}.`, 2);
    if (options["fail-on-drop"] != null && drop > Number(options["fail-on-drop"])) fail(`Overall score dropped by ${fmt(drop)} points (limit ${options["fail-on-drop"]}).`, 2);
  } finally {
    for (const target of worktrees) { try { git(top, ["worktree", "remove", "--force", target]); } catch { /* best effort */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function printReview(comparison, baseRef) {
  const change = comparison.headOverall != null && comparison.baseOverall != null ? comparison.headOverall - comparison.baseOverall : null;
  const changeText = (value) => (value == null ? "" : Math.abs(value) < 0.05 ? color(90, "±0") : value > 0 ? color(32, `+${fmt(value)}`) : color(31, fmt(value)));
  console.log(`\n${color(1, "COVAL review")}  ${baseRef} ${fmt(comparison.baseOverall)} → yours ${color(gradeColor(comparison.headOverall), fmt(comparison.headOverall))}  ${changeText(change)}\n`);
  for (const row of [...comparison.rows].sort((a, b) => (a.change ?? 0) - (b.change ?? 0))) {
    console.log(`  ${row.label.padEnd(22)} ${fmt(row.base).padStart(5)} → ${fmt(row.head).padStart(5)}  ${changeText(row.change)}`);
  }
  if (comparison.newFindings.length) {
    console.log(`\n  New findings (${comparison.newFindings.length}):`);
    for (const fix of comparison.newFindings.slice(0, 8)) console.log(`    • ${fix.agent}: ${fix.title}${fix.location ? color(90, `  ${fix.location}`) : ""}`);
  } else {
    console.log(color(32, "\n  No new findings."));
  }
  console.log("");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (options.version) return console.log(VERSION);
  if (options.help || !command || command === "help") return console.log(HELP);
  const { agents, reviewModule } = loadShared();
  if (command === "scan") {
    const workspace = path.resolve(options._[1] || process.cwd());
    if (!fs.existsSync(workspace)) fail(`${workspace} does not exist.`);
    const result = await scan(agents, workspace, options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printScan(result);
    return;
  }
  if (command === "review") return review(agents, await reviewModule, options);
  fail(`Unknown command "${command}". Run coval --help.`);
}

main().catch((error) => fail(error?.message || String(error)));
