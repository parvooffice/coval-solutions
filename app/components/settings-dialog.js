"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { useDashboardData } from "../dashboard/dashboard-data-provider";

export default function SettingsDialog({ theme, onThemeChange, onNavigate, onClose }) {
  const { dashboard, people, currentUser } = useDashboardData();
  const login = dashboard.primaryProfile?.login || currentUser?.user_metadata?.user_name || currentUser?.user_metadata?.preferred_username || people[0]?.login || "";
  const profile = people.find((person) => person.login === login) || people[0];
  const githubIdentity = currentUser?.identities?.find((identity) => identity.provider === "github");
  const githubLogin = githubIdentity?.identity_data?.user_name || githubIdentity?.identity_data?.login || "";
  const githubConnected = Boolean(githubIdentity || currentUser?.app_metadata?.providers?.includes("github"));
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [githubConnectMessage, setGithubConnectMessage] = useState("");
  const dialogRef = useRef(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    dialogRef.current?.scrollTo({ top: 0 });
    const trapFocus = (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trapFocus);
    return () => {
      window.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function connectGitHub() {
    const client = window.covalSupabase;
    if (!client) {
      setGithubConnectMessage("COVAL authentication is still loading. Close Settings and try again.");
      return;
    }
    setConnectingGitHub(true);
    setGithubConnectMessage("");
    try {
      const { data, error } = await client.auth.linkIdentity({
        provider: "github",
        options: { redirectTo: `${window.location.origin}/dashboard`, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("Supabase did not return a GitHub authorization URL.");
      window.location.assign(data.url);
    } catch (error) {
      setGithubConnectMessage(error.message || "Could not start GitHub connection.");
      setConnectingGitHub(false);
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex="-1">
        <header className="settings-dialog-header">
          <div><span className="eyebrow">WORKSPACE PREFERENCES</span><h2 id="settings-title">Settings &amp; Configuration</h2></div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><Icon name="x" size={18} /></button>
        </header>

        <section className="settings-group" aria-labelledby="settings-theme">
          <h3 id="settings-theme">DISPLAY THEME</h3>
          <div className="settings-option settings-theme-option">
            <div><strong>Appearance mode</strong><p>Choose the canvas that feels right for your workspace.</p></div>
            <div className="settings-theme-actions">
              <button type="button" className={`button${theme === "light" ? " selected" : ""}`} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}><Icon name="sun" size={17} /> Light</button>
              <button type="button" className={`button${theme === "dark" ? " selected" : ""}`} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}><Icon name="moon" size={17} /> Dark</button>
            </div>
          </div>
        </section>

        <section className="settings-group" aria-labelledby="settings-workspace">
          <h3 id="settings-workspace">ACTIVE WORKSPACE</h3>
          <div className="settings-option">
            <div><strong>GitHub organization</strong><p>{dashboard.organization || "Not connected"} · {dashboard.projects?.length || 0} repositories loaded</p></div>
            <span className="settings-tag">{dashboard.configured ? "CONNECTED" : "SETUP REQUIRED"}</span>
          </div>
          <div className="settings-option">
            <div><strong>Your GitHub account</strong><p>{githubConnected ? `Connected${githubLogin ? ` as @${githubLogin}` : ""} · your public repositories and activity load in this workspace.` : "Connect your GitHub identity to load your own public repositories, collaborators, pull requests, and activity."}</p></div>
            {githubConnected
              ? <span className="settings-tag">CONNECTED</span>
              : <button type="button" className="button" onClick={connectGitHub} disabled={connectingGitHub}><Icon name="git" size={15} /> {connectingGitHub ? "Connecting…" : "Connect GitHub"}</button>}
          </div>
          {githubConnectMessage && <p className="settings-connect-message" role="alert">{githubConnectMessage} If Supabase reports that linking is disabled, enable manual identity linking in Authentication settings, then try again.</p>}
          <div className="settings-option">
            <div><strong>GitHub profile</strong><p>{profile ? `${profile.name} (@${profile.login})` : "Connect a GitHub identity to view your profile"}</p></div>
            <button type="button" className="button" disabled={!login} onClick={() => { onNavigate(`profile/${login}`); onClose(); }}>View profile <Icon name="arrowUpRight" size={15} /></button>
          </div>
        </section>

        <section className="settings-group" aria-labelledby="settings-shortcuts">
          <h3 id="settings-shortcuts">KEYBOARD SHORTCUTS</h3>
          <div className="settings-shortcut"><span>Global search</span><kbd>⌘ K</kbd></div>
          <div className="settings-shortcut"><span>Overview</span><kbd>⌘ 1</kbd></div>
          <div className="settings-shortcut"><span>Dismiss dialog / drawer</span><kbd>Esc</kbd></div>
          <div className="settings-shortcut"><span>Send message</span><kbd>Enter</kbd></div>
        </section>
      </section>
    </div>
  );
}
