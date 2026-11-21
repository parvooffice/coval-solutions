import { useEffect, useMemo, useRef, useState } from "react";
import Brand from "./brand";
import Icon from "./dashboard-icon";
import SettingsDialog from "./settings-dialog";
import { Avatar } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";
import { announceNotifications, getDesktop, notificationRoute, notificationText } from "../lib/desktop";

const navItems = [
  { id: "overview", label: "Overview", icon: "grid", shortcut: "⌘1" },
  { id: "code-evaluation", label: "Code Evaluation", icon: "code" },
  { id: "teams", label: "Teams", icon: "briefcase" },
  { id: "feed", label: "Feed", icon: "send" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "engineering", label: "People", icon: "users" },
  { id: "network", label: "Network", icon: "network" },
  { id: "chat", label: "Messages", icon: "message" },
  { id: "billing", label: "Plan", icon: "star" },
];

export default function DashboardShell({
  children,
  route,
  theme,
  drawerOpen,
  searchOpen,
  settingsOpen,
  toast,
  onDrawerToggle,
  onDrawerClose,
  onThemeToggle,
  onSearchOpen,
  onSearchClose,
  onSettingsOpen,
  onSettingsClose,
  onThemeChange,
  onNavigate,
  dataLoading,
  dataError,
  onDataRefresh,
}) {
  const { people, projects, dashboard, currentUser } = useDashboardData();
  const [search, setSearch] = useState("");
  const [selectedSearchResult, setSelectedSearchResult] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(false);
  const [desktopOverlayOpen, setDesktopOverlayOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const notificationRef = useRef(null);
  const unreadNotifications = notifications.filter((notification) => !notification.readAt).length;
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!desktopOverlayOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setDesktopSidebarOpen(false);
        setDesktopOverlayOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [desktopOverlayOpen]);
  useEffect(() => {
    if (!currentUser?.id) {
      setNotifications([]);
      return undefined;
    }
    let active = true;
    const refreshNotifications = () => apiRequest("/api/notifications")
      .then(({ notifications: next = [], settings = {} }) => {
        if (!active) return;
        setNotifications(next);
        window.covalNotificationSettings = settings;
        announceNotifications(next, settings);
      })
      .catch(() => {});
    refreshNotifications();
    const timer = window.setInterval(refreshNotifications, 30_000);
    window.addEventListener("coval-notification-settings", refreshNotifications);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("coval-notification-settings", refreshNotifications);
    };
  }, [currentUser?.id]);
  // COVAL for Windows: clicking a Windows notification opens the matching page.
  useEffect(() => getDesktop()?.onNavigate((target) => onNavigate(target)), [onNavigate]);
  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const closeOutside = (event) => {
      if (!notificationRef.current?.contains(event.target)) setNotificationsOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [notificationsOpen]);
  const results = useMemo(() => {
    const query = search.trim().toLowerCase();
    const routeResults = navItems.map((item) => ({ type: "Section", title: item.label, route: item.id, icon: item.icon }));
    const projectResults = projects.slice(0, 6).map((item) => ({ type: "Repository", title: item.name, route: "projects", icon: "repo" }));
    const personResults = people.slice(0, 6).map((item) => ({ type: "Person", title: item.name, route: `profile/${item.id}`, icon: "users" }));
    return [...routeResults, ...projectResults, ...personResults]
      .filter((item) => !query || `${item.title} ${item.type}`.toLowerCase().includes(query))
      .slice(0, 9);
  }, [search, projects, people]);

  const go = (target) => onNavigate(target);
  const activeRoute = route === "profile" ? "engineering" : route;
  const sidebarOpen = isMobile ? drawerOpen : desktopSidebarOpen;
  const overlayOpen = isMobile ? drawerOpen : desktopOverlayOpen;
  const workspaceName = dashboard.workspaceName || "COVAL community";
  const profileLogin = dashboard.primaryProfile?.login || currentUser?.githubLogin || "";
  const profilePerson = people.find((person) => person.login === profileLogin) || people.find((person) => person.covalUserId === currentUser?.id) || null;
  const accountName = currentUser?.displayName || currentUser?.email?.split("@")[0] || "COVAL member";
  const profileTarget = currentUser?.id ? `profile/member-${currentUser.id}` : profileLogin ? `profile/${profileLogin}` : "";
  const toggleSidebar = () => {
    if (isMobile) {
      onDrawerToggle();
    } else {
      if (desktopSidebarOpen) {
        setDesktopSidebarOpen(false);
        setDesktopOverlayOpen(false);
      } else {
        setDesktopSidebarOpen(true);
        setDesktopOverlayOpen(true);
      }
    }
  };
  const navigateFromSidebar = (target) => {
    onNavigate(target);
    onDrawerClose();
    setDesktopSidebarOpen(false);
    setDesktopOverlayOpen(false);
  };
  async function toggleNotifications() {
    const opening = !notificationsOpen;
    setNotificationsOpen(opening);
    if (!opening) return;
    try {
      const { notifications: next = [] } = await apiRequest("/api/notifications");
      setNotifications(next);
      if (next.some((notification) => !notification.readAt)) {
        await apiRequest("/api/notifications", { method: "PATCH", body: JSON.stringify({ all: true }) });
        const readAt = new Date().toISOString();
        setNotifications(next.map((notification) => ({ ...notification, readAt: notification.readAt || readAt })));
        getDesktop()?.setUnread(0);
      }
    } catch {}
  }

  return (
    <div className={`app-frame${overlayOpen ? " navigation-open" : ""}${!sidebarOpen ? " sidebar-collapsed" : ""}${!isMobile && desktopOverlayOpen ? " sidebar-overlay-open" : ""}`}>
      <aside className={`sidebar${isMobile && drawerOpen ? " sidebar-open" : ""}`} id="navigation-drawer" aria-label="Application navigation" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
        <div className="sidebar-top">
          <Brand onClick={(event) => { event.preventDefault(); navigateFromSidebar("overview"); }} />
          <button type="button" className="icon-button sidebar-close" aria-label="Close navigation menu" onClick={onDrawerClose}><Icon name="x" /></button>
          <div className="workspace-chip">
            <span className="workspace-avatar">A</span>
            <span className="workspace-meta"><strong>{workspaceName}</strong><small>{dashboard.configured ? "GITHUB CONNECTED" : "WORKSPACE"}</small></span>
            <span className="workspace-status" title={dashboard.configured ? "Connected to GitHub" : "GitHub not connected"} />
          </div>
        </div>
        <div className="sidebar-scroll">
          <div className="sidebar-section">
            <span className="sidebar-caption">NAVIGATION</span>
            <nav className="primary-navigation" aria-label="Primary navigation">
              {navItems.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className={`nav-link${activeRoute === item.id ? " active" : ""}`}
                  aria-current={activeRoute === item.id ? "page" : undefined}
                  onClick={(event) => { event.preventDefault(); navigateFromSidebar(item.id); }}
                >
                  <Icon name={item.icon} size={19} />
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                  {item.count && <small className="nav-count">{item.count}</small>}
                  {item.id === "chat" && <i className="nav-live-dot" />}
                </a>
              ))}
            </nav>
          </div>
          <div className="sidebar-section sidebar-collection">
            <div className="sidebar-section-heading"><span className="sidebar-caption">PINNED PROJECTS</span><button type="button" className="quiet-icon" aria-label="Explore projects" onClick={() => navigateFromSidebar("projects")}><Icon name="plus" size={16} /></button></div>
            <div className="sidebar-quick-list">
              {projects.slice(0, 6).map((project) => <button key={project.id} type="button" className="quick-link" onClick={() => navigateFromSidebar("projects")}><i className={`project-dot status-${project.status.toLowerCase()}`} /><span>{project.name}</span><small><Icon name="star" size={12} />{project.stars}</small></button>)}
              {!projects.length && <p className="sidebar-empty">Repositories appear after GitHub is connected.</p>}
            </div>
          </div>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-actions">
            <button type="button" className="sidebar-action" onClick={() => { onSettingsOpen(); onDrawerClose(); setDesktopSidebarOpen(false); setDesktopOverlayOpen(false); }}><Icon name="settings" size={17} /> Settings</button>
          </div>
          <button type="button" className="profile-chip" onClick={() => profileTarget && navigateFromSidebar(profileTarget)} disabled={!profileTarget}>
            <Avatar initials={profilePerson?.initials || accountName.slice(0, 2).toUpperCase()} name={profilePerson?.name || accountName} color={profilePerson?.color || "mint"} size="sm" src={profilePerson?.avatar || currentUser?.avatarUrl} />
            <span><strong>{profilePerson?.name || accountName}</strong><small>My COVAL profile</small></span>
            <Icon name="chevronRight" size={17} />
          </button>
        </div>
      </aside>

      <button type="button" className={`drawer-backdrop${overlayOpen ? " visible" : ""}`} aria-label="Close navigation menu" tabIndex={overlayOpen ? 0 : -1} onClick={toggleSidebar} />

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button type="button" className="menu-button sidebar-menu-toggle" id="navigationMenu" aria-label={sidebarOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={sidebarOpen} aria-controls="navigation-drawer" onClick={toggleSidebar}><Icon name={sidebarOpen ? "x" : "menu"} size={19} /></button>
            <Brand />
          </div>
          <div className="topbar-center">
            <button type="button" className="topbar-search-btn" onClick={onSearchOpen} aria-label="Search directory (Press ⌘K)">
              <span className="search-btn-icon"><Icon name="search" size={17} /></span>
              <span className="search-btn-text">Search people, projects, connections…</span>
              <span className="search-btn-kbd"><kbd>⌘</kbd><kbd>K</kbd></span>
            </button>
          </div>
          <div className="topbar-right">
            <span className={`system-status ${dataError ? "is-error" : dataLoading ? "is-syncing" : ""}`} title={dataError ? "GitHub data could not be loaded" : dataLoading ? "Loading the latest data" : "Data is up to date"}><i /> {dataError ? "NOT CONNECTED" : dataLoading ? "SYNCING" : "LIVE"}</span>
            <div className="notifications-wrap" ref={notificationRef}>
              <button type="button" className="icon-button notifications-button" aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`} title="Notifications" aria-expanded={notificationsOpen} onClick={toggleNotifications}><Icon name="bell" size={19} />{unreadNotifications > 0 && <i className="notification-indicator" />}</button>
              {notificationsOpen && <section className="notifications-popover" role="dialog" aria-label="Notifications"><div className="notifications-popover-heading"><span><b>Notifications</b><small>{unreadNotifications ? `${unreadNotifications} new` : "You're all caught up"}</small></span><button type="button" className="text-button" onClick={() => { setNotificationsOpen(false); onNavigate("engineering"); }}>PEOPLE</button></div>{notifications.length ? <div className="notifications-list">{notifications.map((notification) => <button key={notification.id} type="button" className={`notification-item${notification.readAt ? " is-read" : ""}`} onClick={() => { setNotificationsOpen(false); onNavigate(notificationRoute(notification)); }}><Avatar initials={notification.actor.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()} name={notification.actor.name} size="sm" src={notification.actor.avatar} /><span><strong>{notification.actor.name}</strong><small>{notificationText(notification)}</small><time>{new Date(notification.createdAt).toLocaleString()}</time></span><i /></button>)}</div> : <p className="notifications-empty">Connection updates and team invites will appear here.</p>}</section>}
            </div>
            <button type="button" className="icon-button theme-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title="Toggle theme" onClick={onThemeToggle}><Icon name={theme === "dark" ? "sun" : "moon"} size={19} /></button>
            <span className="top-divider" aria-hidden="true" />
            {dashboard.updatedAt && <span className="topbar-date" aria-label="GitHub data last synced">SYNCED {dashboard.updatedAt.slice(0, 10)}</span>}
            <button type="button" className="topbar-avatar" aria-label={profileTarget ? `${profilePerson?.name || accountName} profile` : `${accountName} account settings`} onClick={() => profileTarget ? onNavigate(profileTarget) : onSettingsOpen()}><Avatar initials={profilePerson?.initials || accountName.slice(0, 2).toUpperCase()} name={profilePerson?.name || accountName} color={profilePerson?.color || "mint"} size="xs" src={profilePerson?.avatar || currentUser?.avatarUrl} /></button>
          </div>
        </header>

        <div className={`content-wrap${route === "chat" ? " content-chat" : ""}`}>
          <div className="workspace-context" aria-label="Current workspace">
            <span className="workspace-context-mark" aria-hidden="true">A</span>
            <strong>{workspaceName}</strong>
            <small>{dashboard.primaryProfile ? "PERSONAL GITHUB" : "COVAL COMMUNITY"}</small>
          </div>
          {dataError && <section className="backend-status-banner" role="status"><div><strong>GitHub data is not connected yet.</strong><p>{dataError} Add the server-only GitHub settings from <code>.env.example</code>, then refresh this dashboard.</p></div><button type="button" className="button" onClick={onDataRefresh}>Retry connection</button></section>}
          {dataLoading && <p className="backend-loading" role="status">Loading live GitHub data…</p>}
          <div className={`page-view page-${route}`}>{children}</div>
          {route !== "chat" && <footer className="app-footer"><span>COVAL <b>V1.0</b></span><span>GITHUB ENGINEERING INTELLIGENCE <i>•</i> {workspaceName.toUpperCase()}</span></footer>}
        </div>
      </main>

      {searchOpen && (
        <div className="search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onSearchClose(); }}>
          <section className="search-dialog" role="dialog" aria-modal="true" aria-label="Search directory">
            <label className="search-dialog-input"><Icon name="search" size={20} /><input autoFocus value={search} onChange={(event) => { setSearch(event.target.value); setSelectedSearchResult(0); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setSelectedSearchResult((index) => Math.min(index + 1, Math.max(results.length - 1, 0))); } else if (event.key === "ArrowUp") { event.preventDefault(); setSelectedSearchResult((index) => Math.max(index - 1, 0)); } else if (event.key === "Enter" && results[selectedSearchResult]) { event.preventDefault(); go(results[selectedSearchResult].route); } }} placeholder="Search people, projects, sections…" /><kbd>ESC</kbd></label>
            <div className="search-results">
              <span className="sidebar-caption">{search ? "RESULTS" : "QUICK JUMP"}</span>
              {results.map((item, index) => <button key={`${item.type}-${item.title}`} type="button" className={`search-result${selectedSearchResult === index ? " selected" : ""}`} onMouseEnter={() => setSelectedSearchResult(index)} onClick={() => go(item.route)}><Icon name={item.icon} size={17} /><span>{item.title}</span><small>{item.type}</small><Icon name="arrowUpRight" size={14} /></button>)}
              {results.length === 0 && <p className="search-empty">No matching people or projects found.</p>}
            </div>
            <div className="search-hint"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>ESC</kbd> Close</span></div>
          </section>
        </div>
      )}
      {settingsOpen && <SettingsDialog theme={theme} onThemeChange={onThemeChange} onNavigate={onNavigate} onClose={onSettingsClose} />}
      {toast && <div className="toast-message" role="status">{toast}</div>}
    </div>
  );
}
