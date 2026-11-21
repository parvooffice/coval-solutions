import { useEffect, useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";
import { getDesktop } from "../lib/desktop";

const NOTIFICATION_OPTIONS = [
  { key: "messages", label: "Messages", detail: "Someone sends you a message." },
  { key: "jobs", label: "Jobs & teams", detail: "New job listings and team-formation posts in the Feed." },
  { key: "scores", label: "Scores", detail: "People share a score card, and your own scoring runs finish." },
  { key: "issues", label: "Issues to solve", detail: "New help requests for repository issues in the Feed." },
  { key: "post_activity", label: "Activity on your posts", detail: "Someone is interested in your post, or accepts your interest." },
  { key: "social", label: "Connections & team invites", detail: "New connections and invitations to join a team." },
];

function NotificationSettings({ signedIn }) {
  const [settings, setSettings] = useState(null);
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState("");
  const desktop = getDesktop();

  useEffect(() => {
    if (!signedIn) return undefined;
    let active = true;
    apiRequest("/api/notifications")
      .then((result) => {
        if (!active) return;
        setSettings(result.settings || {});
        setAvailable(result.settingsAvailable !== false);
      })
      .catch(() => { if (active) setMessage("Notification settings couldn't load. Try again in a moment."); });
    return () => { active = false; };
  }, [signedIn]);

  async function toggle(key) {
    const next = !(settings?.[key] !== false);
    setSettings((current) => ({ ...current, [key]: next }));
    setMessage("");
    try {
      await apiRequest("/api/notifications", { method: "PATCH", body: JSON.stringify({ settings: { [key]: next } }) });
      window.dispatchEvent(new Event("coval-notification-settings"));
    } catch (error) {
      setSettings((current) => ({ ...current, [key]: !next }));
      setMessage(error.message || "That setting couldn't be saved.");
    }
  }

  if (!signedIn) return <p className="settings-connect-message">Sign in to choose your notifications.</p>;
  const options = desktop ? [...NOTIFICATION_OPTIONS, { key: "desktop_popups", label: "Windows pop-ups", detail: "Show these as Windows notifications, even when COVAL is in the tray." }] : NOTIFICATION_OPTIONS;
  return <>
    {options.map((option) => {
      const on = settings?.[option.key] !== false;
      return <div className="settings-option" key={option.key}>
        <div><strong>{option.label}</strong><p>{option.detail}</p></div>
        <button type="button" role="switch" aria-checked={on} aria-label={option.label} className={`settings-switch${on ? " is-on" : ""}`} disabled={!settings || !available} onClick={() => toggle(option.key)}><i /></button>
      </div>;
    })}
    {!available && <p className="settings-connect-message">Notification settings need a one-time database update. Every notification stays on until then.</p>}
    {message && <p className="settings-connect-message" role="alert">{message}</p>}
  </>;
}

export default function SettingsDialog({ theme, onThemeChange, onNavigate, onClose }) {
  const { dashboard, people, currentUser } = useDashboardData();
  const login = dashboard.primaryProfile?.login || currentUser?.githubLogin || "";
  const profile = people.find((person) => person.login === login) || null;
  const githubLogin = currentUser?.githubLogin || "";
  const githubConnected = Boolean(currentUser?.githubConnected);
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
    if (!client || !currentUser?.id) {
      setGithubConnectMessage("COVAL authentication is still loading. Close Settings and try again.");
      return;
    }
    setConnectingGitHub(true);
    setGithubConnectMessage("");
    try {
      const { data, error } = await client.auth.linkIdentity({
        provider: "github",
        options: { redirectTo: `${window.location.origin}/dashboard`, scopes: "read:user user:email", skipBrowserRedirect: true },
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
            <div><strong>Community network</strong><p>People and connections come from COVAL member accounts. {dashboard.projects?.length || 0} of your public repositories are loaded.</p></div>
            <span className="settings-tag">{dashboard.primaryProfile ? "GITHUB LINKED" : "COMMUNITY"}</span>
          </div>
          <div className="settings-option">
            <div><strong>Your GitHub account</strong><p>{githubConnected ? `Connected${githubLogin ? ` as @${githubLogin}` : ""} · your repositories, contribution graph, and activity load in your personal dashboard.` : "Connect GitHub to load your own repositories, contribution graph, pull requests, reviews, and streak. COVAL people and connection features remain available."}</p></div>
            {githubConnected
              ? <span className="settings-tag">CONNECTED</span>
              : <button type="button" className="button" onClick={connectGitHub} disabled={connectingGitHub}><Icon name="git" size={15} /> {connectingGitHub ? "Connecting…" : "Connect GitHub"}</button>}
          </div>
          {githubConnectMessage && <p className="settings-connect-message" role="alert">{githubConnectMessage}</p>}
          <div className="settings-option">
            <div><strong>GitHub profile</strong><p>{profile ? `${profile.name} (@${profile.login})` : "Connect GitHub to view your personal profile"}</p></div>
            <button type="button" className="button" disabled={!login} onClick={() => { onNavigate(`profile/${login}`); onClose(); }}>View profile <Icon name="arrowUpRight" size={15} /></button>
          </div>
        </section>

        <section className="settings-group" aria-labelledby="settings-notifications">
          <h3 id="settings-notifications">NOTIFICATIONS</h3>
          <NotificationSettings signedIn={Boolean(currentUser?.id)} />
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
