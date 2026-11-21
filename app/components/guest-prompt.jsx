import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";

const FIRST_PROMPT_MS = 60_000;
const EXTRA_TIME_MS = 120_000;

async function signIn(provider) {
  const supabase = window.covalSupabase;
  if (!supabase) { window.location.assign("/"); return; }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/dashboard`, skipBrowserRedirect: true, ...(provider === "github" ? { scopes: "read:user user:email" } : {}) },
  });
  if (error || !data?.url) { window.location.assign("/"); return; }
  window.location.assign(data.url);
}

// Guest preview: a banner while exploring, a sign-in prompt after a minute (dismissable once),
// then a final prompt that requires signing in. Any action that needs an account opens it early.
export default function GuestPrompt() {
  const [prompt, setPrompt] = useState(null); // { message, final }
  const [extended, setExtended] = useState(false);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setPrompt({ final: extended, message: "" }), extended ? EXTRA_TIME_MS : FIRST_PROMPT_MS);
    return () => window.clearTimeout(timer);
  }, [extended]);

  useEffect(() => {
    const open = (event) => setPrompt((current) => current?.final ? current : { final: false, message: event.detail?.message || "" });
    window.addEventListener("coval-sign-in-request", open);
    return () => window.removeEventListener("coval-sign-in-request", open);
  }, []);

  useEffect(() => {
    if (!prompt) return undefined;
    const onKey = (event) => { if (event.key === "Escape" && !prompt.final) setPrompt(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt]);

  function keepExploring() {
    setPrompt(null);
    setExtended(true);
  }

  return <>
    <div className="guest-pill" role="status">
      <Icon name="eye" size={14} /> <span>Guest preview with sample data</span>
      <button type="button" onClick={() => setPrompt({ final: false, message: "" })}>Sign in</button>
    </div>
    {prompt && <div className="guest-overlay" role="dialog" aria-modal="true" aria-labelledby="guest-prompt-title">
      <div className="guest-dialog">
        <img src="/coval-logo-dark.png" alt="" width="44" height="44" />
        <h2 id="guest-prompt-title">{prompt.final ? "Sign in to keep exploring" : "Like what you see?"}</h2>
        <p>{prompt.message || (prompt.final
          ? "You've seen the preview. Sign in free to score your own repositories, get AI fix explanations, and post on the feed."
          : "Sign in free to score your own repositories with ten review agents, save your results, and join teams.")}</p>
        <div className="guest-dialog-actions">
          <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => { setBusy("github"); signIn("github"); }}><Icon name="git" size={15} /> {busy === "github" ? "Opening GitHub…" : "Continue with GitHub"}</button>
          <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => { setBusy("google"); signIn("google"); }}>{busy === "google" ? "Opening Google…" : "Continue with Google"}</button>
        </div>
        {prompt.final
          ? <a className="guest-dialog-secondary" href="/">Back to the home page</a>
          : <button type="button" className="guest-dialog-secondary" onClick={keepExploring}>{extended ? "Not now" : "Keep exploring for 2 more minutes"}</button>}
      </div>
    </div>}
  </>;
}
