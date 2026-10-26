import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { getGitHubPublicMemberStats, getDashboardData } from "../../lib/server/github.js";

const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ members: [] });

    const [profiles, connections, dashboard] = await Promise.all([supabaseRest(
      user,
      "coval_profiles?select=user_id,github_login,display_name,avatar_url,created_at,last_seen_at,profile_name,profile_headline,profile_bio,profile_location,profile_company,profile_visibility&order=created_at.asc&limit=500",
    ), supabaseRest(user, `coval_member_connections?select=target_user_id&user_id=eq.${encodeURIComponent(user.id)}`), user.githubConnected && user.login
      ? getDashboardData(user.login, user.githubToken, true, { includePrimaryProfile: false, publicOnly: true, allowSharedGraphqlToken: false }).catch(() => null)
      : Promise.resolve(null)]);
    const connectedIds = new Set((connections || []).map((connection) => connection.target_user_id));
    const orderedProfiles = [...(profiles || [])].sort((left, right) => Number(connectedIds.has(right.user_id)) - Number(connectedIds.has(left.user_id)));
    const statsLogins = [...new Set([
      ...orderedProfiles.map((profile) => profile.github_login),
      ...(dashboard?.people || []).map((person) => person.login),
    ].filter(Boolean))].slice(0, 100);
    const publicStats = await getGitHubPublicMemberStats(statsLogins, user.githubToken);
    const now = Date.now();
    const members = orderedProfiles.map((profile) => ({
      userId: profile.user_id,
      githubLogin: profile.github_login || "",
      name: profile.profile_name || profile.display_name || profile.github_login || "COVAL member",
      avatar: profile.avatar_url || "",
      headline: profile.profile_headline || "",
      bio: profile.profile_bio || "",
      location: profile.profile_location || "",
      company: profile.profile_company || "",
      profileVisibility: profile.profile_visibility || {},
      createdAt: profile.created_at,
      lastSeenAt: profile.last_seen_at,
      isActive: Boolean(profile.last_seen_at && now - new Date(profile.last_seen_at).getTime() <= ACTIVE_WINDOW_MS),
      publicStats: profile.profile_visibility?.contributions === false ? null : publicStats[(profile.github_login || "").toLowerCase()] || null,
    }));
    return Response.json({ members, githubStats: publicStats }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
