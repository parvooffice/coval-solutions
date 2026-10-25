import { requireUser, authorizeGitHubWorkspace, apiError } from "../../lib/server/auth";
import { getDashboardData, getGitHubErrorStatus } from "../../lib/server/github";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const personalWorkspace = user.githubConnected;
    if (!personalWorkspace) await authorizeGitHubWorkspace(user);
    const dashboard = await getDashboardData(user.login === "local" ? "" : user.login, user.githubToken, personalWorkspace);
    return Response.json(dashboard, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error?.status) return apiError(error);
    error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}
