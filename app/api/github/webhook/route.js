import { githubRequest, installationToken, verifyWebhookSignature } from "../../../lib/server/github-app.js";
import { COMMENT_MARKER, compareTargets, renderComment } from "../../../lib/server/pr-review.js";
import { runAnalyzers } from "../../code-evaluation/route.js";

// GitHub App webhook: scores the base and head of each pull request and keeps one COVAL
// comment up to date. GitHub stops waiting after 10 seconds; the run continues and the
// comment appears when scoring finishes (usually under two minutes).
const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

async function upsertComment(owner, repo, number, token, body) {
  const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`, { token });
  const existing = comments.ok ? comments.data.find((comment) => comment.body?.includes(COMMENT_MARKER) && comment.user?.type === "Bot") : null;
  const path = existing ? `/repos/${owner}/${repo}/issues/comments/${existing.id}` : `/repos/${owner}/${repo}/issues/${number}/comments`;
  const result = await githubRequest(path, { token, method: existing ? "PATCH" : "POST", body: { body } });
  if (!result.ok) throw new Error(`GitHub rejected the COVAL comment (HTTP ${result.status}).`);
}

export async function POST(request) {
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get("x-hub-signature-256"))) return Response.json({ error: "Invalid signature." }, { status: 401 });
  const event = request.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true });
  if (event !== "pull_request") return Response.json({ ignored: event });

  let payload;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  const pr = payload.pull_request;
  if (!ACTIONS.has(payload.action) || !pr || pr.draft || !payload.installation?.id) return Response.json({ ignored: payload.action });

  const [owner, repo] = String(payload.repository?.full_name || "").split("/");
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const headRepoUrl = pr.head?.repo?.html_url || repoUrl;
  try {
    const readToken = await installationToken(payload.installation.id, repo, { contents: "read" });
    const commentToken = await installationToken(payload.installation.id, repo, { pull_requests: "write" });
    // Forks: the head commit lives in the fork, which is public for public repositories.
    const sameRepo = headRepoUrl.toLowerCase() === repoUrl.toLowerCase();
    const runs = sameRepo
      ? [runAnalyzers([repoUrl], false, { [repoUrl]: { token: readToken, ref: pr.base.sha } }), runAnalyzers([repoUrl], false, { [repoUrl]: { token: readToken, ref: pr.head.sha } })]
      : [runAnalyzers([repoUrl], false, { [repoUrl]: { token: readToken, ref: pr.base.sha } }), runAnalyzers([headRepoUrl], false, { [headRepoUrl]: { token: "", ref: pr.head.sha } })];
    const [base, head] = await Promise.all(runs);
    const comparison = compareTargets(base.targets?.[0], head.targets?.[0]);
    const appUrl = process.env.COVAL_PUBLIC_URL?.trim() || new URL(request.url).origin;
    await upsertComment(owner, repo, pr.number, commentToken, renderComment(comparison, { repoUrl: headRepoUrl, headSha: pr.head.sha, appUrl: `${appUrl}/dashboard#code-evaluation` }));
    return Response.json({ commented: true, overall: comparison.headOverall });
  } catch (error) {
    console.error("COVAL pull request review failed:", error);
    return Response.json({ error: error.message || "Pull request review failed." }, { status: 500 });
  }
}
