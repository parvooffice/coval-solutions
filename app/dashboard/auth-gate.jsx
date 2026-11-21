import { useEffect, useState } from "react";
import { getBrowserSupabase } from "../lib/supabase-client";
import { endGuestPreview, isGuest, startGuestPreview } from "../lib/guest";
import GuestPrompt from "../components/guest-prompt";

export default function AuthGate({ children }) {
  const [status, setStatus] = useState("checking");
  const [client, setClient] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [guest, setGuest] = useState(false);

  useEffect(() => {
    let active = true;
    let subscription;
    if (new URLSearchParams(window.location.search).get("guest") === "1") startGuestPreview();
    async function start() {
      let supabase = null;
      try { supabase = getBrowserSupabase(); } catch (cause) { if (!isGuest()) throw cause; }
      if (!supabase && isGuest()) {
        // The guest preview works even when sign-in is unavailable.
        window.covalGuest = true;
        setGuest(true);
        setStatus("ready");
        return;
      }
      if (!supabase) throw new Error("Supabase client is not available in this browser.");
      window.covalSupabase = supabase;
      setClient(supabase);
      window.dispatchEvent(new Event("coval-auth-ready"));
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error) throw error;
      if (data.session) {
        endGuestPreview();
        setCurrentUser(data.session.user);
        setStatus("ready");
      } else if (isGuest()) {
        // Signed-out visitors who chose "Explore" get a guest preview with sample data.
        window.covalGuest = true;
        setGuest(true);
        setStatus("ready");
      } else if (import.meta.env.DEV) {
        setStatus("ready");
      } else {
        window.location.replace("/");
      }
      const authState = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        setCurrentUser(session?.user || null);
        if (session) {
          endGuestPreview();
          window.covalGuest = false;
          setGuest(false);
        }
        window.dispatchEvent(new Event("coval-auth-change"));
        if (!session && !import.meta.env.DEV && !isGuest()) window.location.replace("/");
      });
      subscription = authState.data.subscription;
    }
    start().catch(() => { if (active) setStatus("error"); });
    return () => { active = false; subscription?.unsubscribe(); };
  }, []);

  async function signOut() {
    if (client) await client.auth.signOut();
    window.location.replace("/");
  }

  if (import.meta.env.DEV && status !== "ready") return children;
  if (status !== "ready") return <main className="auth-verification-state">{status === "error" ? "Unable to verify your session. Check the Supabase configuration and try again." : "Verifying your COVAL session…"}</main>;
  return <>
    {currentUser && <button type="button" onClick={signOut} aria-label="Sign out of COVAL" className="auth-signout-button">Sign out</button>}
    {children}
    {guest && !currentUser && <GuestPrompt />}
  </>;
}
