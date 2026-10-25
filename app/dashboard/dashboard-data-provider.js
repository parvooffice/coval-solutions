"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/client-api";

const emptyDashboard = {
  configured: false,
  workspaceName: "COVAL community",
  primaryProfile: null,
  metrics: {},
  contributions: { days: [] },
  people: [],
  projects: [],
  activity: [],
  pullRequests: [],
};

const DashboardDataContext = createContext(null);

export function DashboardDataProvider({ children }) {
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [codeEvaluation, setCodeEvaluation] = useState(null);

  const updateCodeEvaluation = useCallback((report) => setCodeEvaluation(report), []);
  const loadCodeEvaluation = useCallback(async () => {
    return apiRequest("/api/code-evaluation");
  }, []);

  const loadDashboard = useCallback(async () => {
      const client = window.covalSupabase;
      let nextUser = null;
      if (client) {
        const { data } = await client.auth.getSession();
        nextUser = data.session?.user || null;
      }
      const result = await apiRequest("/api/dashboard");
      return { result, user: nextUser };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { result, user } = await loadDashboard();
      setCurrentUser(user);
      setDashboard(result);
    } catch (cause) {
      setDashboard(emptyDashboard);
      setError(cause.message || "Unable to load live GitHub data.");
    } finally {
      setLoading(false);
    }
  }, [loadDashboard]);

  useEffect(() => {
    let active = true;
    const initialLoad = async () => {
      try {
        const { result, user } = await loadDashboard();
        if (!active) return;
        setCurrentUser(user);
        setDashboard(result);
        setError("");
      } catch (cause) {
        if (!active) return;
        setDashboard(emptyDashboard);
        setError(cause.message || "Unable to load live GitHub data.");
      } finally {
        if (active) setLoading(false);
      }
    };
    initialLoad();
    window.addEventListener("coval-auth-ready", initialLoad);
    window.addEventListener("coval-auth-change", initialLoad);
    return () => {
      active = false;
      window.removeEventListener("coval-auth-ready", initialLoad);
      window.removeEventListener("coval-auth-change", initialLoad);
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (!currentUser?.id) return undefined;
    const sendPresence = () => {
      if (document.visibilityState !== "visible") return;
      apiRequest("/api/presence", { method: "POST" }).catch(() => {});
    };
    sendPresence();
    const timer = window.setInterval(sendPresence, 60_000);
    document.addEventListener("visibilitychange", sendPresence);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sendPresence);
    };
  }, [currentUser?.id]);

  useEffect(() => {
    let active = true;
    const refreshEvaluation = () => loadCodeEvaluation()
      .then((report) => { if (active) setCodeEvaluation(report); })
      .catch(() => { if (active) setCodeEvaluation(null); });
    refreshEvaluation();
    window.addEventListener("coval-auth-ready", refreshEvaluation);
    window.addEventListener("coval-auth-change", refreshEvaluation);
    return () => { active = false; };
  }, [loadCodeEvaluation]);

  const value = useMemo(() => ({
    dashboard,
    codeEvaluation,
    updateCodeEvaluation,
    people: dashboard.people || [],
    projects: dashboard.projects || [],
    activity: dashboard.activity || [],
    pullRequests: dashboard.pullRequests || [],
    metrics: dashboard.metrics || {},
    contributions: dashboard.contributions || { days: [] },
    loading,
    error,
    currentUser,
    refresh,
  }), [dashboard, codeEvaluation, updateCodeEvaluation, loading, error, currentUser, refresh]);

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

export function useDashboardData() {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error("useDashboardData must be used inside DashboardDataProvider.");
  return value;
}
