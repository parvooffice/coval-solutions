import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

export const maxDuration = 300;

const ROOT = process.cwd();
const REPORT_FILE = path.join(ROOT, "app", "data", "code-evaluation.json");
const MAX_TARGETS = 5;
const MAX_SAVED_TARGETS = 25;
const emptyEvaluation = { schemaVersion: 1, generatedAt: null, urlFile: "", targets: [] };

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function signPublicReport(userId, githubLogin, report) {
  const secret = process.env.CODE_EVALUATION_FUNCTION_SECRET?.trim();
  if (!secret) throw Object.assign(new Error("Shared score signing is not configured."), { status: 503 });
  const payload = JSON.stringify({ userId, githubLogin, report: canonicalJson(report) });
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function hasValidPublicSignature(row) {
  try {
    const expected = Buffer.from(signPublicReport(row.user_id, row.github_login, row.public_report), "base64url");
    const actual = Buffer.from(row.public_signature || "", "base64url");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

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

async function runAnalyzers(urls) {
  const endpoint = process.env.CODE_EVALUATION_API_URL?.trim();
  const secret = process.env.CODE_EVALUATION_FUNCTION_SECRET?.trim();
  if (!endpoint || !secret) {
    throw Object.assign(new Error("Code evaluation is not configured. Set CODE_EVALUATION_API_URL and CODE_EVALUATION_FUNCTION_SECRET in the Vercel frontend project."), { status: 503 });
  }

  let url;
  try { url = new URL(endpoint); }
  catch { throw Object.assign(new Error("CODE_EVALUATION_API_URL must be a valid HTTPS URL."), { status: 503 }); }
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("CODE_EVALUATION_API_URL must use HTTPS."), { status: 503 });
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
    throw Object.assign(new Error(error?.name === "TimeoutError" ? "Code evaluation exceeded the Vercel function time limit. Try fewer or smaller repositories." : "COVAL could not reach the Vercel code evaluation service."), { status: 504 });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `The code evaluation service returned ${response.status}.`), { status: response.status >= 500 ? 502 : response.status });
  }
  const bundle = payload.report || payload;
  bundle.urlFile = "submitted repository URLs";
  for (const target of bundle.targets || []) {
    for (const analyzer of target.evaluations || []) delete analyzer.reportPath;
  }
  return bundle;
}

async function readSavedEvaluation(user) {
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

async function assertPublicRepositories(urls) {
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
    if (!Array.isArray(body?.urls)) throw Object.assign(new Error("Submit repository URLs as a JSON array."), { status: 400 });
    if (body.urls.length > MAX_TARGETS) throw Object.assign(new Error(`Evaluate up to ${MAX_TARGETS} repositories per run.`), { status: 400 });
    const urls = [...new Set(body.urls.map(parseGitHubRepository))];
    if (urls.length === 0) throw Object.assign(new Error("Add at least one GitHub repository URL."), { status: 400 });
    if (urls.length > MAX_TARGETS) throw Object.assign(new Error(`Evaluate up to ${MAX_TARGETS} repositories per run.`), { status: 400 });

    if (isPublic) await assertPublicRepositories(urls);

    const previous = await readSavedEvaluation(user);
    const analyzedReport = await runAnalyzers(urls);
    const publicReport = isPublic ? structuredClone(analyzedReport) : null;
    const publicSignature = isPublic ? signPublicReport(user.id, user.login, publicReport) : null;
    const report = analyzedReport;
    const submitted = new Set(urls.map((url) => url.toLowerCase()));
    report.targets = [
      ...(previous.targets || []).filter((target) => !submitted.has(String(target.url || target.input).toLowerCase())),
      ...report.targets,
    ].slice(-MAX_SAVED_TARGETS);
    await saveEvaluation(user, report, isPublic, publicReport, publicSignature);
    report.isPublic = isPublic;
    report.publicEvaluations = [];
    return Response.json({ report }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
