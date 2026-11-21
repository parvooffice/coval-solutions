import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import DesktopHandoffPage, { desktopHandoff, finishDesktopSignIn } from "./components/desktop-handoff.jsx";
import "./globals.css";
import "./motion.css";
import "./portfolio.css";

// Each kind of page is its own download, so the sign-in page doesn't load the dashboard.
const DashboardPage = lazy(() => import("./dashboard/page.jsx"));
const LoginPage = lazy(() => import("./components/login-page.jsx"));
const SharedReportPage = lazy(() => import("./components/shared-report-page.jsx"));

function BootScreen() {
  return <div className="boot-screen" aria-busy="true" aria-label="Loading COVAL"><img src="/coval-logo-light.png" alt="" width="40" height="40" /></div>;
}

// Checked once, before Supabase reads the sign-in response from the address bar.
const handoff = finishDesktopSignIn() || desktopHandoff();

function Page() {
  if (handoff) return <DesktopHandoffPage handoff={handoff} />;
  const shared = window.location.pathname.match(/^\/report\/([A-Za-z0-9_-]{6,64})\/?$/);
  if (shared) return <SharedReportPage token={shared[1]} />;
  if (window.location.pathname.startsWith("/dashboard")) return <DashboardPage />;
  return <LoginPage />;
}

const rootElement = document.getElementById("root");
const appRoot = window.covalReactRoot || createRoot(rootElement);
window.covalReactRoot = appRoot;
appRoot.render(<Suspense fallback={<BootScreen />}><Page /></Suspense>);
// The boot background in index.html only covers the first paint; the app's own styles take over.
window.setTimeout(() => { delete document.documentElement.dataset.boot; }, 1500);
