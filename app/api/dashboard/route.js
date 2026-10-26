import { requireUser, apiError } from "../../lib/server/auth.js";
import { getDashboardData, getGitHubErrorStatus } from "../../lib/server/github.js";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const personalWorkspace = user.githubConnected;
    if (!personalWorkspace || !user.login) {
      return Response.json({
        configured: false,
        source: "personal-github",
        workspaceName: "COVAL community",
        primaryProfile: null,
        metrics: {},
        contributions: { total: 0, commits: 0, pullRequests: 0, reviews: 0, issues: 0, days: [], current: 0, best: 0 },
        people: [],
        projects: [],
        activity: [],
        pullRequests: [],
        updatedAt: null,
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const dashboard = await getDashboardData(
      personalWorkspace ? user.login : "",
      user.githubToken,
      personalWorkspace,
      { includePrimaryProfile: personalWorkspace, publicOnly: !personalWorkspace, allowSharedGraphqlToken: false },
    );
    return Response.json(dashboard, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error?.status) return apiError(error);
    error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}
