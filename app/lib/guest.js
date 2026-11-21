// Guest preview: visitors can explore the dashboard without signing in. Reads return
// sample or empty data; anything that needs an account opens the sign-in prompt.

const GUEST_KEY = "coval-guest-preview";
// Endpoints that work without an account.
const PUBLIC_GET = [/^\/api\/feed(\?|$)/, /^\/api\/share\?/, /^\/api\/badge\?/, /^\/api\/github\/app$/, /^\/api\/health$/];

export function startGuestPreview() {
  try { window.sessionStorage.setItem(GUEST_KEY, "1"); } catch { /* storage may be blocked */ }
}

export function endGuestPreview() {
  try { window.sessionStorage.removeItem(GUEST_KEY); } catch { /* storage may be blocked */ }
}

export function isGuest() {
  if (typeof window === "undefined") return false;
  if (window.covalGuest === true) return true;
  if (new URLSearchParams(window.location.search).get("guest") === "1") return true;
  try { return window.sessionStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
}

// Ask the dashboard to show the sign-in prompt (see GuestPrompt).
export function requestSignIn(message = "") {
  window.dispatchEvent(new CustomEvent("coval-sign-in-request", { detail: { message } }));
}

export function isPublicGet(path, method = "GET") {
  return method.toUpperCase() === "GET" && PUBLIC_GET.some((pattern) => pattern.test(path));
}

export const SAMPLE_REPORT_URL = "/sample-report.json";
