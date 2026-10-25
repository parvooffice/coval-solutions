import { apiError, requireUser } from "../../lib/server/auth";
import { getGitHubErrorStatus, getGitHubProfile } from "../../lib/server/github";

export async function GET(request) {
  try {
    await requireUser(request);
    const login = new URL(request.url).searchParams.get("login");
    const profile = await getGitHubProfile(login);
    return Response.json(profile, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!error.status) error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}
