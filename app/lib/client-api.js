export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const client = typeof window !== "undefined" ? window.covalSupabase : null;
  const session = client ? (await client.auth.getSession()).data?.session : null;
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  const hasGitHubIdentity = session?.user?.identities?.some((identity) => identity.provider === "github")
    || session?.user?.app_metadata?.providers?.includes("github");
  if (session?.provider_token && hasGitHubIdentity) {
    headers.set("x-github-provider-token", session.provider_token);
  }
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}
