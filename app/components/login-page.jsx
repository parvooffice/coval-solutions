import { useEffect } from "react";
import { getBrowserSupabase } from "../lib/supabase-client";

export default function LoginPage() {
  useEffect(() => {
    try {
      getBrowserSupabase()?.auth.getSession().then(({ data }) => {
        if (data.session) window.location.replace("/dashboard");
      }).catch(() => {});
    } catch { /* The sign-in frame displays setup errors. */ }
  }, []);
  const loginUrl = new URL("/coval-login.html", window.location.origin);
  const error = new URLSearchParams(window.location.search).get("error");
  if (error) loginUrl.searchParams.set("error", error);
  return <iframe className="login-page-frame" title="COVAL sign in" src={loginUrl.toString()} />;
}
