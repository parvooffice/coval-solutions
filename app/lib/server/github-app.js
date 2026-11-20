import { createHmac, createSign, timingSafeEqual } from "node:crypto";

// COVAL GitHub App: read-only access to repositories an organization chooses, plus
// pull request comments. Configure GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM; "\n" escapes
// are allowed), GITHUB_APP_WEBHOOK_SECRET, and GITHUB_APP_SLUG.

const API = "https://api.github.com";

export function githubAppConfig() {
  return {
    appId: process.env.GITHUB_APP_ID?.trim() || "",
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim(),
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() || "",
    slug: process.env.GITHUB_APP_SLUG?.trim() || "",
  };
}

export const githubAppConfigured = () => {
  const config = githubAppConfig();
  return Boolean(config.appId && config.privateKey);
};

export function installUrl() {
  const { slug } = githubAppConfig();
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : "";
}

const base64url = (value) => Buffer.from(value).toString("base64url");

// Short-lived JWT that authenticates as the app itself (RS256, valid for 9 minutes).
export function appJwt(now = Math.floor(Date.now() / 1000)) {
  const { appId, privateKey } = githubAppConfig();
  if (!appId || !privateKey) throw Object.assign(new Error("The COVAL GitHub App is not configured."), { status: 503 });
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function githubRequest(path, { token, appAuth = false, method = "GET", body } = {}) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "COVAL-GitHub-App", "X-GitHub-Api-Version": "2022-11-28" };
  if (appAuth) headers.Authorization = `Bearer ${appJwt()}`;
  else if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data: payload };
}

export async function installationForRepository(owner, repo) {
  const { ok, data } = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { appAuth: true });
  return ok ? data.id : null;
}

// Installation token limited to one repository and the permissions asked for (expires in 1 hour).
export async function installationToken(installationId, repo, permissions = { contents: "read" }) {
  const { ok, data } = await githubRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    appAuth: true, method: "POST", body: { repositories: [repo], permissions },
  });
  if (!ok || !data?.token) throw Object.assign(new Error("GitHub did not grant COVAL access to this repository."), { status: 502 });
  return data.token;
}

export function verifyWebhookSignature(rawBody, signatureHeader) {
  const { webhookSecret } = githubAppConfig();
  if (!webhookSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseRepositoryUrl(url) {
  const match = String(url || "").match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

// For each URL the anonymous API cannot see (private), check the member can read it with their own
// GitHub sign-in, then mint a read-only installation token. Returns { access, privateUrls }.
export async function resolvePrivateAccess(urls, memberGithubToken) {
  const access = {};
  const privateUrls = [];
  for (const url of urls) {
    const parsed = parseRepositoryUrl(url);
    if (!parsed) continue;
    // The server token (if any) only raises GitHub's rate limit; visibility is still read from the response.
    const publicView = await githubRequest(`/repos/${parsed.owner}/${parsed.repo}`, { token: process.env.GITHUB_TOKEN?.trim() || undefined });
    if (publicView.ok && publicView.data?.private === false) continue;
    privateUrls.push(url);
    if (!githubAppConfigured()) {
      throw Object.assign(new Error(`${parsed.owner}/${parsed.repo} is private or does not exist. Private repositories need the COVAL GitHub App.`), { status: 400 });
    }
    if (!memberGithubToken) {
      throw Object.assign(new Error("Sign in with GitHub so COVAL can confirm you have access to this private repository."), { status: 403 });
    }
    const memberView = await githubRequest(`/repos/${parsed.owner}/${parsed.repo}`, { token: memberGithubToken });
    if (!memberView.ok) throw Object.assign(new Error(`Your GitHub account cannot read ${parsed.owner}/${parsed.repo}.`), { status: 403 });
    const installationId = await installationForRepository(parsed.owner, parsed.repo);
    if (!installationId) {
      const link = installUrl();
      throw Object.assign(new Error(`Install the COVAL GitHub App on ${parsed.owner}/${parsed.repo} to score it${link ? `: ${link}` : "."}`), { status: 400 });
    }
    access[url] = { token: await installationToken(installationId, parsed.repo) };
  }
  return { access, privateUrls };
}
