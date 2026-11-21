import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../lib/supabase-client";
import { useEffect, useState } from "react";

// Sign-in for COVAL for Windows happens in the user's browser:
// 1. The app opens /dashboard?desktop_handoff=<state>&next=<Supabase authorize URL>.
//    This page remembers the state in this browser and continues to GitHub or Google.
// 2. The provider returns to /dashboard#access_token=… (as on the website). Because the
//    state is remembered, this page passes that response to the app through
//    coval://auth?state=…&return=…, and the app finishes sign-in in its own window.
// The browser itself is not signed in by this, and the response is removed from its address bar.

const KEY = "coval.desktopHandoff";
const TTL_MS = 15 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function readPending() {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || "null");
    return value && STATE_PATTERN.test(value.state) && Date.now() - value.at < TTL_MS ? value : null;
  } catch {
    return null;
  }
}

function isAuthorizeUrl(value) {
  try {
    const target = new URL(value);
    return Boolean(SUPABASE_URL) && target.origin === new URL(SUPABASE_URL).origin && target.pathname === "/auth/v1/authorize";
  } catch {
    return false;
  }
}

// Returns what to render instead of the normal page, or null when this is not a desktop sign-in.
export function desktopHandoff() {
  if (typeof window === "undefined" || !window.location.pathname.startsWith("/dashboard")) return null;
  const params = new URLSearchParams(window.location.search);
  const state = params.get("desktop_handoff");
  const next = params.get("next");

  if (state) {
    if (!STATE_PATTERN.test(state) || !isAuthorizeUrl(next)) return { kind: "error", message: "This sign-in link is not valid. Start again from the COVAL app." };
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ state, at: Date.now() }));
    } catch {
      return { kind: "error", message: "This browser blocked COVAL from saving sign-in progress. Allow site data for COVAL, or try another browser." };
    }
    window.location.replace(next);
    return { kind: "redirecting" };
  }

  const pending = readPending();
  const response = `${window.location.search}${window.location.hash}`;
  const isProviderResponse = /(?:access_token|error_description|error)=/.test(response) || params.has("code");
  if (!pending || !isProviderResponse) return null;

  try { window.localStorage.removeItem(KEY); } catch { /* already gone */ }
  // Windows browsers won't open app links longer than about 2,000 characters, and the full
  // response (with the access token) is longer. So send only the short refresh token and the
  // GitHub token; the app exchanges the refresh token for a fresh session itself.
  const values = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  for (const [key, value] of params) if (!values.has(key)) values.set(key, value);
  window.history.replaceState(null, "", "/dashboard"); // keep tokens out of the browser's address bar
  const link = new URLSearchParams({ state: pending.state });
  const refreshToken = values.get("refresh_token");
  if (refreshToken) {
    link.set("rt", refreshToken);
    if (values.get("provider_token")) link.set("pt", values.get("provider_token"));
    if (values.get("provider_refresh_token")) link.set("prt", values.get("provider_refresh_token"));
  } else {
    link.set("error", (values.get("error_description") || values.get("error") || "Sign-in was cancelled.").slice(0, 200));
  }
  const appUrl = `coval://auth?${link}`;
  window.location.href = appUrl;
  return { kind: "return", appUrl, failed: !refreshToken };
}

// In COVAL for Windows: the app opened /dashboard#desktop_rt=… after the browser sign-in.
// Exchange the refresh token for a session, then hand it to Supabase the usual way (URL hash),
// keeping the GitHub token so private repositories keep working.
export function finishDesktopSignIn() {
  if (typeof window === "undefined" || !window.covalDesktop) return null;
  const values = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const refreshToken = values.get("desktop_rt");
  if (!refreshToken) return null;
  window.history.replaceState(null, "", "/dashboard");
  const finished = fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }).then(async (result) => {
    const session = await result.json().catch(() => ({}));
    if (!result.ok || !session.access_token) throw new Error(session.error_description || session.msg || "Sign-in could not be completed.");
    const hash = new URLSearchParams({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: String(session.expires_in),
      expires_at: String(session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600)),
      token_type: session.token_type || "bearer",
      type: "signin",
    });
    if (values.get("desktop_pt")) hash.set("provider_token", values.get("desktop_pt"));
    if (values.get("desktop_prt")) hash.set("provider_refresh_token", values.get("desktop_prt"));
    window.history.replaceState(null, "", `/dashboard#${hash}`);
    window.location.reload();
  });
  return { kind: "finishing", finished };
}

export default function DesktopHandoffPage({ handoff }) {
  const [failure, setFailure] = useState("");
  useEffect(() => {
    handoff.finished?.catch((error) => setFailure(error.message || "Sign-in could not be completed."));
  }, [handoff]);
  if (handoff.kind === "finishing") {
    return <main className="desktop-handoff">
      <img src="/coval-logo-dark.png" alt="" width="56" height="56" />
      <h1>{failure ? "Sign-in didn't finish" : "Signing you in…"}</h1>
      <p>{failure || "Just a moment."}</p>
      {failure && <a href="/">Sign in again</a>}
    </main>;
  }
  const title = handoff.kind === "redirecting" ? "Opening sign-in…"
    : handoff.kind === "error" ? "Something went wrong"
      : handoff.failed ? "Sign-in was cancelled" : "You're signed in";
  const text = handoff.kind === "redirecting" ? "Taking you to sign in for the COVAL app."
    : handoff.kind === "error" ? handoff.message
      : "Your browser should ask to open COVAL. If it doesn't, click the button below. You can close this tab afterwards.";
  return <main className="desktop-handoff">
    <img src="/coval-logo-dark.png" alt="" width="56" height="56" />
    <h1>{title}</h1>
    <p>{text}</p>
    {handoff.kind === "return" && <a href={handoff.appUrl}>Open COVAL</a>}
  </main>;
}
