import { isGuest, isPublicGet, requestSignIn } from "./guest";

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const client = typeof window !== "undefined" ? window.covalSupabase : null;
  const session = client ? (await client.auth.getSession()).data?.session : null;
  // Guest preview: private reads come back empty instead of erroring; changes ask the visitor to sign in.
  if (!session && isGuest() && !isPublicGet(path, options.method || "GET")) {
    if ((options.method || "GET").toUpperCase() === "GET") return {};
    requestSignIn();
    throw Object.assign(new Error("Sign in to do that. This is a guest preview."), { status: 401 });
  }
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  const hasGitHubIdentity = session?.user?.identities?.some((identity) => identity.provider === "github")
    || session?.user?.app_metadata?.providers?.includes("github");
  if (session?.provider_token && hasGitHubIdentity) headers.set("x-github-provider-token", session.provider_token);
  if (options.body && !headers.has("Content-Type") && !(typeof FormData !== "undefined" && options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}
