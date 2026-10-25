import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";
import { getGitHubErrorStatus, getGitHubProfile } from "../../lib/server/github";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const { searchParams } = new URL(request.url);
    const memberId = searchParams.get("memberId");
    if (memberId) {
      if (!uuidPattern.test(memberId)) return Response.json({ error: "Choose a valid COVAL member." }, { status: 400 });
      const [member] = await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,avatar_url,created_at,last_seen_at&user_id=eq.${encodeURIComponent(memberId)}&limit=1`);
      if (!member) return Response.json({ error: "COVAL member not found." }, { status: 404 });
      if (!member.github_login) {
        return Response.json({
          id: `member-${member.user_id}`,
          covalUserId: member.user_id,
          login: "",
          name: member.display_name || "COVAL member",
          initials: (member.display_name || "COVAL member").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase(),
          avatar: member.avatar_url || "",
          url: "",
          role: "COVAL member",
          bio: "COVAL community member. Connect GitHub to share public repositories and contribution activity.",
          color: "mint",
          commits: 0,
          prs: 0,
          reviews: 0,
          repositories: [],
          followers: 0,
          publicRepositories: 0,
          contributions: null,
          createdAt: member.created_at,
          isActive: Boolean(member.last_seen_at && Date.now() - new Date(member.last_seen_at).getTime() <= 3 * 60 * 1000),
        }, { headers: { "Cache-Control": "private, no-store" } });
      }
      const isOwnMember = member.user_id === user.id && user.githubConnected;
      const githubProfile = await getGitHubProfile(member.github_login, isOwnMember ? user.githubToken : "", isOwnMember);
      return Response.json({ ...githubProfile, covalUserId: member.user_id, createdAt: member.created_at }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const login = searchParams.get("login");
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    const [covalMember] = await supabaseRest(user, `coval_profiles?select=user_id&github_login=ilike.${encodeURIComponent(login || "")}&limit=1`);
    const isOwnGitHubProfile = user.githubConnected && user.login?.toLowerCase() === login?.toLowerCase();
    const profile = await getGitHubProfile(login, isOwnGitHubProfile ? user.githubToken : "", isOwnGitHubProfile);
    return Response.json({ ...profile, covalUserId: covalMember?.user_id || "" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!error.status) error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}
