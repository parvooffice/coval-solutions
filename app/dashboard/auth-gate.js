"use client";

import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zriirrxmkfggyhoagtov.supabase.co";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_-LR8TY6q0UfmOevgRmDzWA_VJqck38C";

export default function AuthGate({ children }) {
  const [status, setStatus] = useState("checking");
  const [client, setClient] = useState(null);

  useEffect(() => {
    let active = true;
    let authSubscription = null;
    const start = async () => {
      if (!window.supabase) {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector('script[data-supabase-sdk="true"]');
          if (existing) {
            existing.addEventListener("load", resolve, { once: true });
            existing.addEventListener("error", reject, { once: true });
            return;
          }
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
          script.dataset.supabaseSdk = "true";
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const supabase = window.covalSupabase || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      window.covalSupabase = supabase;
      window.dispatchEvent(new Event("coval-auth-ready"));
      if (!active) return;
      setClient(supabase);
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (process.env.NODE_ENV === "development") {
        setStatus("ready");
        const { data } = supabase.auth.onAuthStateChange(() => window.dispatchEvent(new Event("coval-auth-change")));
        authSubscription = data.subscription;
        return;
      }
      if (error || !data.session) {
        window.location.replace("/");
        return;
      }
      setStatus("ready");
      const { data: authState } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!session) window.location.replace("/");
      });
      authSubscription = authState.subscription;
    };
    start().catch(() => {
      if (active) setStatus("error");
    });
    return () => { active = false; authSubscription?.unsubscribe(); };
  }, []);

  const logout = async () => {
    if (client) await client.auth.signOut();
    window.location.replace("/");
  };

  // Keep local dashboard work viewable without a Supabase account. Production
  // builds still require a valid session.
  if (process.env.NODE_ENV === "development") return children;

  if (status !== "ready") {
    return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f7f7f5", color: "#333", fontFamily: "Arial, sans-serif" }}>
      {status === "error" ? "Unable to verify your session. Please refresh or sign in again." : "Verifying your COVAL session…"}
    </main>;
  }

  return <>
    <button type="button" onClick={logout} aria-label="Sign out of COVAL" style={{ position: "fixed", zIndex: 1000, right: 18, bottom: 18, border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#222", padding: "10px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 18px #0001" }}>Sign out</button>
    {children}
  </>;
}
