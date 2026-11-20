import { githubAppConfigured, installUrl } from "../../../lib/server/github-app.js";

// Public: whether the COVAL GitHub App is set up, and where to install it.
export async function GET() {
  return Response.json({ configured: githubAppConfigured(), installUrl: installUrl() }, { headers: { "Cache-Control": "public, max-age=300" } });
}
