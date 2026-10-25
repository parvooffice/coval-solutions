const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function requireUser(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    if (process.env.NODE_ENV === "development") return { id: "local-development-user", token: null, login: "local" };
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
  const githubConnected = Boolean(githubIdentity || user.app_metadata?.providers?.includes("github"));
  const login = githubProfile.user_name || githubProfile.login || (githubConnected
    ? user.user_metadata?.user_name || user.user_metadata?.preferred_username || user.user_metadata?.nickname || ""
    : "");
  let githubToken = request.headers.get("x-github-provider-token")?.trim() || "";
  let verifiedLogin = "";
  if (githubToken) {
    if (!githubConnected) throw Object.assign(new Error("Connect GitHub to this COVAL account before using a GitHub access token."), { status: 403 });
    if (githubToken.length > 8192) throw Object.assign(new Error("GitHub authorization token is invalid."), { status: 400 });
    const githubResponse = await fetch("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${githubToken}`, "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
    if (!githubResponse.ok) {
      githubToken = "";
    } else {
      const githubUser = await githubResponse.json();
      verifiedLogin = githubUser.login || "";
      if (!verifiedLogin || (login && verifiedLogin.toLowerCase() !== login.toLowerCase())) {
        throw Object.assign(new Error("The connected GitHub account does not match your COVAL account. Reconnect the matching GitHub identity."), { status: 403 });
      }
    }
  }
  return {
    id: user.id,
    token,
    login: verifiedLogin || login,
    githubConnected,
    githubToken,
  };
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
