import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ members: [] });

    const profiles = await supabaseRest(
      user,
      "coval_profiles?select=user_id,github_login,display_name,avatar_url,created_at,last_seen_at&order=created_at.asc&limit=500",
    );
    const now = Date.now();
    const members = (profiles || []).map((profile) => ({
      userId: profile.user_id,
      githubLogin: profile.github_login || "",
      name: profile.display_name || profile.github_login || "COVAL member",
      avatar: profile.avatar_url || "",
      createdAt: profile.created_at,
      lastSeenAt: profile.last_seen_at,
      isActive: Boolean(profile.last_seen_at && now - new Date(profile.last_seen_at).getTime() <= ACTIVE_WINDOW_MS),
    }));
    return Response.json({ members }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
