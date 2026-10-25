import { apiError, requireUser } from "../../lib/server/auth";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (process.env.NODE_ENV !== "development" && !user.githubConnected) {
      throw Object.assign(new Error("Sign in with GitHub to import your repositories."), { status: 403 });
    }
    if (!user.login || user.login === "local") return Response.json({ repositories: [] });

    const endpoint = user.githubToken
      ? "https://api.github.com/user/repos?visibility=public&affiliation=owner&sort=updated&direction=desc&per_page=100"
      : `https://api.github.com/users/${encodeURIComponent(user.login)}/repos?type=owner&sort=updated&direction=desc&per_page=100`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(user.githubToken ? { Authorization: `Bearer ${user.githubToken}` } : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw Object.assign(new Error(detail.message || `GitHub repository lookup failed (${response.status}).`), { status: response.status === 403 ? 429 : 502 });
    }
    const repositories = (await response.json()).map((repository) => ({
      name: repository.name,
      fullName: repository.full_name,
      url: repository.html_url,
      description: repository.description || "",
      stars: repository.stargazers_count,
      updatedAt: repository.pushed_at || repository.updated_at,
    }));
    return Response.json({ repositories }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
