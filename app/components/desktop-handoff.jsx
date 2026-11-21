import { SUPABASE_URL } from "../lib/supabase-client";

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
  window.history.replaceState(null, "", "/dashboard");
  const appUrl = `coval://auth?state=${encodeURIComponent(pending.state)}&return=${encodeURIComponent(response)}`;
  window.location.href = appUrl;
  return { kind: "return", appUrl, failed: /error/.test(response) && !/access_token=/.test(response) };
}

export default function DesktopHandoffPage({ handoff }) {
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
