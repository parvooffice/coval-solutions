import { createRoot } from "react-dom/client";
import DashboardPage from "./dashboard/page.jsx";
import LoginPage from "./components/login-page.jsx";
import "./globals.css";

function App() {
  if (window.location.pathname.startsWith("/dashboard")) return <DashboardPage />;
  return <LoginPage />;
}

const rootElement = document.getElementById("root");
const appRoot = window.covalReactRoot || createRoot(rootElement);
window.covalReactRoot = appRoot;
appRoot.render(<App />);
