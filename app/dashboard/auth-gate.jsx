import { useEffect, useState } from "react";
import { getBrowserSupabase } from "../lib/supabase-client";

export default function AuthGate({ children }) {
  const [status, setStatus] = useState("checking");
  const [client, setClient] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    let active = true;
    let subscription;
    async function start() {
      const supabase = getBrowserSupabase();
      if (!supabase) throw new Error("Supabase client is not available in this browser.");
      window.covalSupabase = supabase;
      setClient(supabase);
      window.dispatchEvent(new Event("coval-auth-ready"));
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error) throw error;
      if (data.session) {
        setCurrentUser(data.session.user);
        setStatus("ready");
      } else if (import.meta.env.DEV) {
        setStatus("ready");
      } else {
        window.location.replace("/");
      }
      const authState = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        setCurrentUser(session?.user || null);
        window.dispatchEvent(new Event("coval-auth-change"));
        if (!session && !import.meta.env.DEV) window.location.replace("/");
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
  </>;
}
