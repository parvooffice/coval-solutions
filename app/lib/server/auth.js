const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function requireUser(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    if (process.env.NODE_ENV === "development") return { id: "local-development-user", token: null, login: process.env.GITHUB_USERNAME || "local" };
    throw Object.assign(new Error("Sign in to use this feature."), { status: 401 });
  }
  if (!supabaseUrl() || !supabaseKey()) {
    throw Object.assign(new Error("Supabase auth is not configured on the server."), { status: 503 });
  }
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: supabaseKey(), Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw Object.assign(new Error("Your session is no longer valid. Sign in again."), { status: 401 });
  const user = await response.json();
  const githubIdentity = user.identities?.find((identity) => identity.provider === "github");
  const githubProfile = githubIdentity?.identity_data || {};
  return {
    id: user.id,
    token,
    login: githubProfile.user_name || githubProfile.login || user.user_metadata?.user_name || user.user_metadata?.preferred_username || user.user_metadata?.nickname || "",
  };
}

export async function authorizeGitHubWorkspace(user) {
  if (process.env.NODE_ENV === "development") return;
  if (!user.login) throw Object.assign(new Error("Sign in with GitHub to view this workspace."), { status: 403 });
  const org = process.env.GITHUB_ORG?.trim();
  if (!org) {
    const allowedLogins = (process.env.COVAL_ALLOWED_GITHUB_USERS || "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);
    if (!allowedLogins.includes(user.login.toLowerCase())) {
      throw Object.assign(new Error("Your GitHub account is not on the workspace allowlist."), { status: 403 });
    }
    return;
  }
  if (!process.env.GITHUB_TOKEN) throw Object.assign(new Error("GITHUB_TOKEN is required to verify workspace organization membership."), { status: 503 });
  const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user.login)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
    redirect: "manual",
  });
  if (response.status === 204 || response.status === 302) return;
  if (response.status === 404) throw Object.assign(new Error("Your GitHub account is not a member of the configured organization."), { status: 403 });
  throw Object.assign(new Error("COVAL could not verify your GitHub organization membership. Check the token's read:org permission."), { status: 503 });
}

export async function supabaseRest(user, path, init = {}) {
  if (!user.token || !supabaseUrl() || !supabaseKey()) {
    throw Object.assign(new Error("Persistent storage requires a signed-in Supabase account and server Supabase configuration."), { status: 503 });
  }
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: supabaseKey(),
      Authorization: `Bearer ${user.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.message || payload?.hint || `Supabase returned ${response.status}.`), { status: response.status });
  return payload;
}

export function apiError(error) {
  return Response.json({ error: error?.message || "Unexpected server error." }, { status: error?.status || 500 });
}
