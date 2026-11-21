import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import DashboardShell from "../components/dashboard-shell";
import AuthGate from "./auth-gate";
import OverviewPage from "../components/overview-page";

import { PAGE_LOADERS, prefetchRoute } from "./page-loaders";

const PeoplePage = lazy(PAGE_LOADERS.engineering);
const ProjectsPage = lazy(PAGE_LOADERS.projects);
const NetworkPage = lazy(PAGE_LOADERS.network);
const TeamsPage = lazy(PAGE_LOADERS.teams);
const BillingPage = lazy(PAGE_LOADERS.billing);
const FeedPage = lazy(PAGE_LOADERS.feed);
const ActivityPage = lazy(PAGE_LOADERS.activity);
const MessagesPage = lazy(PAGE_LOADERS.chat);
const ProfilePage = lazy(PAGE_LOADERS.profile);
const CodeEvaluationPage = lazy(PAGE_LOADERS["code-evaluation"]);

function PageSkeleton() {
  return <div className="page-skeleton" aria-busy="true" aria-label="Loading">
    <span className="skeleton skeleton-eyebrow" />
    <span className="skeleton skeleton-title" />
    <span className="skeleton skeleton-line" />
    <div className="page-skeleton-grid">{[0, 1, 2].map((item) => <span key={item} className="skeleton skeleton-card" />)}</div>
  </div>;
}
import { DashboardDataProvider, useDashboardData } from "./dashboard-data-provider";

const routes = ["overview", "code-evaluation", "engineering", "projects", "network", "teams", "feed", "billing", "activity", "chat", "profile"];

const LAST_ROUTE_KEY = "coval-last-route";

function getRouteFromHash() {
  const route = window.location.hash.replace(/^#/, "").split("/")[0];
  return routes.includes(route) ? route : "overview";
}

// Opening /dashboard with no section returns to the section used last time.
function restoreLastRoute() {
  if (window.location.hash) return;
  try {
    const last = window.localStorage.getItem(LAST_ROUTE_KEY) || "";
    if (routes.includes(last) && last !== "profile") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${last}`);
  } catch { /* storage blocked */ }
}
if (typeof window !== "undefined") restoreLastRoute();

function subscribeToHashChange(callback) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getServerRoute() {
  return "overview";
}

function getProfileIdFromHash() {
  return window.location.hash.replace(/^#/, "").split("/")[1] || "";
}

function getChatLoginFromHash() {
  return window.location.hash.replace(/^#/, "").split("/")[1] || "";
}

function getServerProfileId() {
  return "";
}

function getServerChatLogin() {
  return "";
}

function subscribeToThemeChange(callback) {
  window.addEventListener("storage", callback);
  window.addEventListener("coval-theme-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("coval-theme-change", callback);
  };
}

function getStoredTheme() {
  return window.localStorage.getItem("coval-theme") === "dark" ? "dark" : "light";
}

function getServerTheme() {
  return "light";
}

function DashboardContent() {
  const { loading, error, refresh } = useDashboardData();
  const route = useSyncExternalStore(subscribeToHashChange, getRouteFromHash, getServerRoute);
  const profileId = useSyncExternalStore(subscribeToHashChange, getProfileIdFromHash, getServerProfileId);
  const chatLogin = useSyncExternalStore(subscribeToHashChange, getChatLoginFromHash, getServerChatLogin);
  const theme = useSyncExternalStore(subscribeToThemeChange, getStoredTheme, getServerTheme);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setDrawerOpen(false);
        setSettingsOpen(false);
      }
      if (!isEditing && (event.metaKey || event.ctrlKey) && event.key === "1") {
        event.preventDefault();
        window.location.hash = "overview";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    // Cross-fade colors when the theme changes (see .theme-changing in motion.css).
    const root = document.documentElement;
    const changing = Boolean(root.dataset.theme) && root.dataset.theme !== theme;
    if (changing) root.classList.add("theme-changing");
    root.dataset.theme = theme;
    if (!changing) return undefined;
    const timer = window.setTimeout(() => root.classList.remove("theme-changing"), 400);
    return () => window.clearTimeout(timer);
  }, [theme]);

  // New section: start at the top, and remember it for next time.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    try { window.localStorage.setItem(LAST_ROUTE_KEY, route); } catch { /* storage blocked */ }
  }, [route, profileId]);

  // Warm up the other sections once the first screen has settled.
  useEffect(() => {
    const warm = () => Object.keys(PAGE_LOADERS).forEach(prefetchRoute);
    const id = "requestIdleCallback" in window ? window.requestIdleCallback(warm, { timeout: 4000 }) : window.setTimeout(warm, 2500);
    return () => ("cancelIdleCallback" in window ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigate = useCallback((nextRoute) => {
    window.location.hash = nextRoute;
    setDrawerOpen(false);
    setSearchOpen(false);
    setSettingsOpen(false);
  }, []);

  const page = useMemo(() => {
    const notify = (message) => setToast(message);
    switch (route) {
      case "engineering":
        return <PeoplePage navigate={navigate} notify={notify} />;
      case "code-evaluation":
        return <CodeEvaluationPage />;
      case "projects":
        return <ProjectsPage navigate={navigate} />;
      case "network":
        return <NetworkPage navigate={navigate} notify={notify} />;
      case "teams":
        return <TeamsPage navigate={navigate} notify={notify} />;
      case "feed":
        return <FeedPage navigate={navigate} notify={notify} />;
      case "billing":
        return <BillingPage notify={notify} />;
      case "activity":
        return <ActivityPage navigate={navigate} />;
      case "chat":
        return <MessagesPage notify={notify} targetLogin={chatLogin} />;
      case "profile":
        return <ProfilePage personId={profileId} navigate={navigate} notify={notify} />;
      default:
        return <OverviewPage navigate={navigate} notify={notify} onConnectGitHub={() => setSettingsOpen(true)} />;
    }
  }, [chatLogin, navigate, profileId, route]);

  return (
    <DashboardShell
      route={route}
      theme={theme}
      drawerOpen={drawerOpen}
      searchOpen={searchOpen}
      settingsOpen={settingsOpen}
      toast={toast}
      onDrawerToggle={() => setDrawerOpen((open) => !open)}
      onDrawerClose={() => setDrawerOpen(false)}
      onThemeToggle={() => {
        window.localStorage.setItem("coval-theme", theme === "light" ? "dark" : "light");
        window.dispatchEvent(new Event("coval-theme-change"));
      }}
      onSearchOpen={() => setSearchOpen(true)}
      onSearchClose={() => setSearchOpen(false)}
      onSettingsOpen={() => setSettingsOpen(true)}
      onSettingsClose={() => setSettingsOpen(false)}
      onNavigate={navigate}
      dataLoading={loading}
      dataError={error}
      onDataRefresh={refresh}
      onThemeChange={(nextTheme) => {
        if (nextTheme !== theme) {
          window.localStorage.setItem("coval-theme", nextTheme);
          window.dispatchEvent(new Event("coval-theme-change"));
        }
      }}
    >
      <Suspense fallback={<PageSkeleton />}>
        <div className="route-view" key={route === "profile" ? `profile-${profileId}` : route}>{page}</div>
      </Suspense>
    </DashboardShell>
  );
}

export default function Home() {
  return <AuthGate><DashboardDataProvider><DashboardContent /></DashboardDataProvider></AuthGate>;
}
