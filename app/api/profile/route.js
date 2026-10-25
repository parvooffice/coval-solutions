import { apiError, requireUser } from "../../lib/server/auth";
import { getGitHubErrorStatus, getGitHubProfile } from "../../lib/server/github";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const login = new URL(request.url).searchParams.get("login");
    const isOwnGitHubProfile = user.githubConnected && user.login?.toLowerCase() === login?.toLowerCase();
    const profile = await getGitHubProfile(login, isOwnGitHubProfile ? user.githubToken : "", isOwnGitHubProfile);
    return Response.json(profile, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!error.status) error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}
