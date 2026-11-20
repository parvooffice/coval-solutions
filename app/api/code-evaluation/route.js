import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { hasValidPublicSignature, signPublicReport } from "../../lib/server/evaluation-sharing.js";
import { consumeQuota } from "../../lib/server/billing.js";

const ROOT = path.resolve(process.cwd());
const REPORT_FILE = path.join(ROOT, "app", "data", "code-evaluation.json");
const execFileAsync = promisify(execFile);
const MAX_TARGETS = 5;
const MAX_SAVED_TARGETS = 25;
const emptyEvaluation = { schemaVersion: 1, generatedAt: null, urlFile: "", targets: [] };

function parseGitHubRepository(value) {
  if (typeof value !== "string" || value.length > 500) {
    throw Object.assign(new Error("Each repository must be a GitHub URL under 500 characters."), { status: 400 });
  }

  let url;
  try { url = new URL(value.trim()); }
  catch { throw Object.assign(new Error(`Invalid repository URL: ${value}`), { status: 400 }); }

  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash || segments.length !== 2) {
    throw Object.assign(new Error(`Use a repository URL such as https://github.com/owner/repository: ${value}`), { status: 400 });
  }
  const [owner, rawRepository] = segments;
  const repository = rawRepository.replace(/\.git$/i, "");
  const githubPart = /^[A-Za-z0-9_.-]+$/;
  if (!githubPart.test(owner) || !githubPart.test(repository) || owner === "." || owner === ".." || repository === "." || repository === "..") {
    throw Object.assign(new Error(`Invalid GitHub owner or repository in URL: ${value}`), { status: 400 });
  }
  return `https://github.com/${owner}/${repository}`;
}

async function runAnalyzers(urls, localWorkspace = false) {
  if (process.env.NODE_ENV === "development") {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "coval-local-evaluation-"));
    const reportDir = path.join(workDir, "reports");
    const outputPath = path.join(workDir, "evaluation.json");
    try {
      const args = [
        path.join(ROOT, "scripts", "run-code-evaluation.py"),
        "--report-dir", reportDir,
        "--output", outputPath,
      ];
      if (localWorkspace) args.push("--local-workspace");
      else args.push("--targets-json", JSON.stringify(urls));
      await execFileAsync(process.env.CODE_EVALUATION_PYTHON || "python", args, { cwd: ROOT, env: process.env, timeout: 285_000, maxBuffer: 10 * 1024 * 1024 });
      const bundle = JSON.parse(await readFile(outputPath, "utf8"));
      bundle.urlFile = "submitted repository URLs";
      for (const target of bundle.targets || []) {
        for (const analyzer of target.evaluations || []) delete analyzer.reportPath;
      }
      return bundle;
    } catch (error) {
      const details = error?.stderr?.toString().trim() || error?.stdout?.toString().trim();
      throw Object.assign(new Error(details || error.message || "The local analyzers could not finish this run."), { status: 502 });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const endpoint = process.env.CODE_EVALUATION_API_URL?.trim();
  const secret = process.env.CODE_EVALUATION_FUNCTION_SECRET?.trim();
  if (!endpoint || !secret) {
    throw Object.assign(new Error("Code evaluation is not configured. Set CODE_EVALUATION_API_URL and CODE_EVALUATION_FUNCTION_SECRET for the Express and Python services."), { status: 503 });
  }

  let url;
  try { url = new URL(endpoint); }
  catch { throw Object.assign(new Error("CODE_EVALUATION_API_URL must be a valid HTTP or HTTPS URL."), { status: 503 }); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "analyzer"].includes(url.hostname))) {
    throw Object.assign(new Error("Use HTTPS for a remote analyzer, or an internal HTTP URL for local Docker services."), { status: 503 });
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-coval-evaluation-secret": secret,
      },
      body: JSON.stringify({ urls }),
      cache: "no-store",
      signal: AbortSignal.timeout(285_000),
    });
  } catch (error) {
    throw Object.assign(new Error(error?.name === "TimeoutError" ? "Code evaluation exceeded the analyzer time limit. Try fewer or smaller repositories." : "COVAL could not reach the Python analyzer service."), { status: 504 });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || payload.detail || `The Python analyzer returned ${response.status}.`), { status: response.status >= 500 ? 502 : response.status });
  }
  const bundle = payload.report || payload;
  bundle.urlFile = "submitted repository URLs";
  for (const target of bundle.targets || []) {
    for (const analyzer of target.evaluations || []) delete analyzer.reportPath;
  }
  return bundle;
}

export async function readSavedEvaluation(user) {
  if (user.token) {
    const rows = await supabaseRest(user, `coval_code_evaluations?select=report,is_public,github_login&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    return { ...(rows?.[0]?.report || emptyEvaluation), isPublic: rows?.[0]?.is_public || false, publicEvaluations: [] };
  }
  if (process.env.NODE_ENV === "development") {
    try { return JSON.parse(await readFile(REPORT_FILE, "utf8")); }
    catch { return emptyEvaluation; }
  }
  return emptyEvaluation;
}

async function saveEvaluation(user, report, isPublic, publicReport, publicSignature) {
  if (user.token) {
    await supabaseRest(user, "coval_code_evaluations?on_conflict=user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: user.id, report, public_report: publicReport, public_signature: publicSignature, is_public: isPublic, github_login: user.login || null, updated_at: new Date().toISOString() }),
    });
    return;
  }
  if (process.env.NODE_ENV === "development") {
    await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return;
  }
  throw Object.assign(new Error("Sign in to save code evaluation results."), { status: 401 });
}

async function readPublicEvaluations(user) {
  if (!user.token) return [];
  const rows = await supabaseRest(user, "coval_code_evaluations?select=user_id,public_report,public_signature,github_login,updated_at&is_public=eq.true&order=updated_at.desc&limit=30");
  return (rows || []).filter(hasValidPublicSignature).map((row) => ({
    generatedAt: row.public_report?.generatedAt || null,
    githubLogin: row.github_login || "COVAL member",
    sharedAt: row.updated_at,
    targets: (row.public_report?.targets || []).map((target) => ({
      name: target.name,
      url: target.url,
      generatedAt: target.generatedAt,
      evaluations: (target.evaluations || []).map(({ id, label, status, score, grade, summary, breakdown }) => ({ id, label, status, score, grade, summary, breakdown })),
    })),
  }));
}

export async function assertPublicRepositories(urls) {
  for (const url of urls) {
    const [, owner, repository] = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i) || [];
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "COVAL-code-evaluation", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw Object.assign(new Error(`COVAL could not confirm ${owner}/${repository} is public. Only public repositories can be shared with the community.`), { status: 400 });
    }
    const repositoryInfo = await response.json();
    if (repositoryInfo.private) {
      throw Object.assign(new Error(`The repository ${owner}/${repository} is private. Private repository scores cannot be shared.`), { status: 400 });
    }
  }
}

function requireGitHubSignIn(user) {
  if (process.env.NODE_ENV !== "development" && !user.login) {
    throw Object.assign(new Error("Sign in with GitHub to evaluate repositories."), { status: 403 });
  }
}

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const report = await readSavedEvaluation(user);
    report.publicEvaluations = await readPublicEvaluations(user);
    return Response.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    requireGitHubSignIn(user);
    if (Number(request.headers.get("content-length") || 0) > 16_384) {
      throw Object.assign(new Error("Keep each evaluation request under 16 KB."), { status: 413 });
    }
    const body = await request.json();
    const isPublic = body?.isPublic === true;
    const localWorkspace = body?.localWorkspace === true;
    if (localWorkspace && process.env.NODE_ENV !== "development") {
      throw Object.assign(new Error("Local workspace scoring is only available in development."), { status: 403 });
    }
    if (localWorkspace && isPublic) {
      throw Object.assign(new Error("Local workspace scores cannot be shared."), { status: 400 });
    }
    if (!localWorkspace && !Array.isArray(body?.urls)) throw Object.assign(new Error("Submit repository URLs as a JSON array."), { status: 400 });
    if (!localWorkspace && body.urls.length > MAX_TARGETS) throw Object.assign(new Error(`Evaluate up to ${MAX_TARGETS} repositories per run.`), { status: 400 });
    const urls = localWorkspace ? [] : [...new Set(body.urls.map(parseGitHubRepository))];
    if (!localWorkspace && urls.length === 0) throw Object.assign(new Error("Add at least one GitHub repository URL."), { status: 400 });
    if (urls.length > MAX_TARGETS) throw Object.assign(new Error(`Evaluate up to ${MAX_TARGETS} repositories per run.`), { status: 400 });

    if (isPublic) await assertPublicRepositories(urls);
    if (!localWorkspace) await consumeQuota(user, "evaluation");

    const previous = await readSavedEvaluation(user);
    const analyzedReport = await runAnalyzers(urls, localWorkspace);
    const publicReport = isPublic ? structuredClone(analyzedReport) : null;
    const publicSignature = isPublic ? signPublicReport(user.id, user.login, publicReport) : null;
    const report = analyzedReport;
    const targetKey = (target) => String(target.url || target.input).toLowerCase();
    const submitted = new Set((analyzedReport.targets || []).map(targetKey));
    // Keep the last run's scores beside each re-scored repository so members can see what changed.
    const previousByKey = new Map((previous.targets || []).map((target) => [targetKey(target), target]));
    for (const target of report.targets || []) {
      const earlier = previousByKey.get(targetKey(target));
      if (!earlier) continue;
      const scores = Object.fromEntries((earlier.evaluations || []).filter((item) => item.score != null).map((item) => [item.id, item.score]));
      if (Object.keys(scores).length) target.previous = { generatedAt: earlier.generatedAt || null, scores };
      const values = Object.values(scores).map(Number);
      const earlierOverall = values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
      target.history = [...(Array.isArray(earlier.history) ? earlier.history : []), { generatedAt: earlier.generatedAt || null, overall: earlierOverall }]
        .filter((point) => typeof point.overall === "number").slice(-11);
    }
    report.targets = [
      ...(previous.targets || []).filter((target) => localWorkspace
        ? target.source !== "local"
        : !submitted.has(String(target.url || target.input).toLowerCase())),
      ...report.targets,
    ].slice(-MAX_SAVED_TARGETS);
    report.dismissed = Array.isArray(previous.dismissed) ? previous.dismissed.slice(-500) : [];
    await saveEvaluation(user, report, isPublic, publicReport, publicSignature);
    report.isPublic = isPublic;
    report.publicEvaluations = [];
    return Response.json({ report }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

const MAX_DISMISSED = 500;

// Dismiss or restore one finding. Keys look like "<repo url>|<agent id>|<title>|<location>".
export async function PATCH(request) {
  try {
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const key = typeof body?.key === "string" ? body.key.slice(0, 600) : "";
    if (!key || key.split("|").length < 3) throw Object.assign(new Error("Choose a finding to dismiss."), { status: 400 });
    const report = await readSavedEvaluation(user);
    const dismissed = new Set(Array.isArray(report.dismissed) ? report.dismissed : []);
    if (body.restore === true) dismissed.delete(key);
    else dismissed.add(key);
    report.dismissed = [...dismissed].slice(-MAX_DISMISSED);
    delete report.publicEvaluations;
    if (user.token) {
      await supabaseRest(user, `coval_code_evaluations?user_id=eq.${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ report: { ...report, isPublic: undefined }, updated_at: new Date().toISOString() }),
      });
    } else if (process.env.NODE_ENV === "development") {
      await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}
`, "utf8");
    } else {
      throw Object.assign(new Error("Sign in to dismiss findings."), { status: 401 });
    }
    return Response.json({ dismissed: report.dismissed });
  } catch (error) {
    return apiError(error);
  }
}

// Delete all of the member's saved evaluation data: reports, dismissed findings, and share links.
export async function DELETE(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) throw Object.assign(new Error("Sign in to delete your data."), { status: 401 });
    const owner = encodeURIComponent(user.id);
    await supabaseRest(user, `coval_shared_reports?user_id=eq.${owner}`, { method: "DELETE" }).catch((error) => {
      if (error.status !== 404) throw error; // the share-links migration may not be applied yet
    });
    await supabaseRest(user, `coval_code_evaluations?user_id=eq.${owner}`, { method: "DELETE" });
    return Response.json({ deleted: true });
  } catch (error) {
    return apiError(error);
  }
}
