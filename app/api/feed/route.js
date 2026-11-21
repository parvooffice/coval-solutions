import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { loadSharedReport, TOKEN_PATTERN } from "../../lib/server/shared-reports.js";

const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(["showcase", "job", "team"]);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

async function optionalUser(request) {
  if (!request.headers.get("authorization")) return null;
  try { return await requireUser(request); } catch { return null; }
}

async function publicFeed(kind) {
  if (!supabaseUrl() || !supabaseKey()) return [];
  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/coval_public_feed`, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: `Bearer ${supabaseKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ feed_kind: kind || null, max_rows: 50 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return []; // feed migration not applied yet
  if (!response.ok) throw Object.assign(new Error("Could not load the feed."), { status: 502 });
  return response.json();
}

// Attach verified score cards: the score always comes from the signed shared report.
async function scoreCards(tokens) {
  const cards = new Map();
  await Promise.all([...new Set(tokens.filter(Boolean))].map(async (token) => {
    try {
      const report = await loadSharedReport(token);
      if (!report) return;
      const scores = (report.evaluations || []).filter((item) => item.status === "complete" && typeof item.score === "number");
      const overall = scores.length ? scores.reduce((sum, item) => sum + item.score, 0) / scores.length : null;
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      cards.set(token, {
        token, name: report.name, url: report.url, overall: overall == null ? null : Math.round(overall * 10) / 10,
        best: sorted.slice(0, 2).map(({ label, score }) => ({ label, score })), weakest: sorted.at(-1) ? { label: sorted.at(-1).label, score: sorted.at(-1).score } : null,
      });
    } catch { /* skip unreadable reports */ }
  }));
  return cards;
}

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const kind = KINDS.has(params.get("kind")) ? params.get("kind") : null;
    const user = await optionalUser(request);
    const rows = await publicFeed(kind);
    const cards = await scoreCards(rows.map((row) => row.share_token));

    let mine = new Map();
    let queues = new Map();
    let myShares = [];
    let myTeams = [];
    if (user?.token && rows.length) {
      const ids = rows.map((row) => row.id).join(",");
      const interests = await supabaseRest(user, `coval_post_interests?select=post_id,user_id,note,status,created_at&post_id=in.(${ids})`);
      mine = new Map(interests.filter((row) => row.user_id === user.id).map((row) => [row.post_id, row]));
      const authored = new Set(rows.filter((row) => row.author_id === user.id).map((row) => row.id));
      const queueRows = interests.filter((row) => authored.has(row.post_id));
      const memberIds = [...new Set(queueRows.map((row) => row.user_id))];
      const profiles = memberIds.length
        ? await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,profile_name,avatar_url,profile_headline&user_id=in.(${memberIds.join(",")})`)
        : [];
      const profileById = new Map(profiles.map((profile) => [profile.user_id, profile]));
      for (const row of queueRows) {
        const profile = profileById.get(row.user_id) || {};
        if (!queues.has(row.post_id)) queues.set(row.post_id, []);
        queues.get(row.post_id).push({
          userId: row.user_id, note: row.note, status: row.status, createdAt: row.created_at,
          name: profile.profile_name || profile.display_name || profile.github_login || "COVAL member",
          login: profile.github_login || "", avatar: profile.avatar_url || "", headline: profile.profile_headline || "",
        });
      }
    }
    if (user?.token && params.get("composer") === "1") {
      myShares = await supabaseRest(user, `coval_shared_reports?select=token,target_url,snapshot->>name&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`).catch(() => []);
      const memberships = await supabaseRest(user, `coval_team_members?select=team_id,role&user_id=eq.${encodeURIComponent(user.id)}&role=eq.admin&status=eq.active`).catch(() => []);
      const teamIds = memberships.map((row) => row.team_id);
      myTeams = teamIds.length ? await supabaseRest(user, `coval_teams?select=id,name&id=in.(${teamIds.join(",")})`).catch(() => []) : [];
    }

    const posts = rows.map((row) => ({
      id: row.id, kind: row.kind, title: row.title, body: row.body, location: row.location, closed: row.closed, createdAt: row.created_at,
      teamLinked: Boolean(row.team_id), interestCount: row.interest_count,
      author: { id: row.author_id, name: row.author_name, login: row.author_login || "", avatar: row.author_avatar || "", headline: row.author_headline || "" },
      score: row.share_token ? cards.get(row.share_token) || null : null,
      isMine: Boolean(user && row.author_id === user.id),
      myInterest: mine.get(row.id) ? { status: mine.get(row.id).status, note: mine.get(row.id).note } : null,
      queue: queues.get(row.id) || [],
    }));
    return Response.json(
      { posts, signedIn: Boolean(user?.token), myShares: myShares.map((share) => ({ token: share.token, name: share.name || share.target_url })), myTeams },
      { headers: { "Cache-Control": user ? "private, no-store" : "public, max-age=30" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) throw Object.assign(new Error("Sign in to post or respond."), { status: 401 });
    const body = await request.json().catch(() => ({}));
    const rpc = (name, args) => supabaseRest(user, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

    if (body.action === "create") {
      if (!KINDS.has(body.kind)) throw badRequest("Choose what kind of post this is.");
      const title = String(body.title || "").trim();
      const text = String(body.body || "").trim();
      if (title.length < 3 || title.length > 120) throw badRequest("Titles must be 3 to 120 characters.");
      if (text.length > 2000) throw badRequest("Keep posts under 2,000 characters.");
      if (body.kind === "showcase" && !TOKEN_PATTERN.test(body.shareToken || "")) throw badRequest("Pick a shared report to showcase. Share a repository from Code Evaluation first.");
      const recent = await supabaseRest(user, `coval_posts?select=id&author_id=eq.${encodeURIComponent(user.id)}&created_at=gt.${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
      if (recent.length >= 10) throw Object.assign(new Error("You can publish up to 10 posts a day."), { status: 429 });
      const [post] = await supabaseRest(user, "coval_posts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          author_id: user.id, kind: body.kind, title, body: text,
          share_token: TOKEN_PATTERN.test(body.shareToken || "") ? body.shareToken : null,
          team_id: body.kind === "team" && uuidPattern.test(body.teamId || "") ? body.teamId : null,
          location: body.location ? String(body.location).trim().slice(0, 80) : null,
        }),
      });
      return Response.json({ post });
    }

    if (!uuidPattern.test(body.postId || "")) throw badRequest("Choose a post.");
    const postId = body.postId;
    if (body.action === "interest") return Response.json({ ok: await rpc("coval_express_interest", { post: postId, interest_note: String(body.note || "").slice(0, 500) }) });
    if (body.action === "withdraw") return Response.json({ ok: await rpc("coval_withdraw_interest", { post: postId }) });
    if (body.action === "respond") {
      if (!uuidPattern.test(body.userId || "") || typeof body.accept !== "boolean") throw badRequest("Choose a member and a response.");
      return Response.json({ ok: await rpc("coval_respond_interest", { post: postId, member: body.userId, accept: body.accept }) });
    }
    if (body.action === "close") {
      await supabaseRest(user, `coval_posts?id=eq.${postId}&author_id=eq.${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ closed: body.closed !== false }) });
      return Response.json({ ok: true });
    }
    if (body.action === "delete") {
      await supabaseRest(user, `coval_posts?id=eq.${postId}&author_id=eq.${encodeURIComponent(user.id)}`, { method: "DELETE" });
      return Response.json({ ok: true });
    }
    throw badRequest("Unknown feed action.");
  } catch (error) {
    return apiError(error);
  }
}
