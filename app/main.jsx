import { createRoot } from "react-dom/client";
import DashboardPage from "./dashboard/page.jsx";
import LoginPage from "./components/login-page.jsx";
import SharedReportPage from "./components/shared-report-page.jsx";
import DesktopHandoffPage, { desktopHandoff, finishDesktopSignIn } from "./components/desktop-handoff.jsx";
import "./globals.css";

// Checked once, before Supabase reads the sign-in response from the address bar.
const handoff = finishDesktopSignIn() || desktopHandoff();

function App() {
  if (handoff) return <DesktopHandoffPage handoff={handoff} />;
  const shared = window.location.pathname.match(/^\/report\/([A-Za-z0-9_-]{6,64})\/?$/);
  if (shared) return <SharedReportPage token={shared[1]} />;
  if (window.location.pathname.startsWith("/dashboard")) return <DashboardPage />;
  return <LoginPage />;
}

const rootElement = document.getElementById("root");
const appRoot = window.covalReactRoot || createRoot(rootElement);
window.covalReactRoot = appRoot;
appRoot.render(<App />);
