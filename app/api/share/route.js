import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { signPublicReport } from "../../lib/server/evaluation-sharing.js";
import { loadSharedReport, newShareToken, shareSnapshot, TOKEN_PATTERN } from "../../lib/server/shared-reports.js";
import { assertPublicRepositories, readSavedEvaluation } from "../code-evaluation/route.js";

// Public: anyone with the link can read a shared report.
export async function GET(request) {
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    const report = await loadSharedReport(token);
    if (!report) return Response.json({ error: "This shared report does not exist or was removed." }, { status: 404 });
    return Response.json({ report }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    return apiError(error);
  }
}

// Create (or refresh) the share link for one of your public repositories.
export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) throw Object.assign(new Error("Sign in to share a report."), { status: 401 });
    const { targetUrl } = await request.json().catch(() => ({}));
    const report = await readSavedEvaluation(user);
    const target = (report.targets || []).find((item) => item.url === targetUrl && item.source === "github");
    if (!target) throw Object.assign(new Error("Score this repository before sharing it."), { status: 404 });
    await assertPublicRepositories([target.url]);

    const snapshot = shareSnapshot(target);
    const signature = signPublicReport(user.id, user.login || null, snapshot);
    const [existing] = await supabaseRest(user, `coval_shared_reports?select=token&user_id=eq.${encodeURIComponent(user.id)}&target_url=eq.${encodeURIComponent(target.url)}&limit=1`);
    const token = existing?.token || newShareToken();
    await supabaseRest(user, "coval_shared_reports?on_conflict=token", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ token, user_id: user.id, github_login: user.login || null, target_url: target.url, snapshot, signature, created_at: new Date().toISOString() }),
    });
    const origin = new URL(request.url).origin;
    return Response.json({
      token,
      shareUrl: `${origin}/report/${token}`,
      badgeUrl: `${origin}/api/badge?token=${token}`,
      markdown: `[![COVAL score](${origin}/api/badge?token=${token})](${origin}/report/${token})`,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request) {
  try {
    const user = await requireUser(request);
    const { token } = await request.json().catch(() => ({}));
    if (!TOKEN_PATTERN.test(token || "")) throw Object.assign(new Error("Choose a share link to remove."), { status: 400 });
    await supabaseRest(user, `coval_shared_reports?token=eq.${encodeURIComponent(token)}&user_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
    return Response.json({ removed: true });
  } catch (error) {
    return apiError(error);
  }
}
