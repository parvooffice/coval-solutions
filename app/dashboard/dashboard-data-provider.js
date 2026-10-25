"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/client-api";

const emptyDashboard = {
  configured: false,
  organization: "",
  primaryProfile: null,
  metrics: {},
  contributions: { days: [] },
  people: [],
  teams: [],
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
    let active = true;
    apiRequest("/api/code-evaluation")
      .then((result) => { if (active) setCodeEvaluation(result); })
      .catch(() => { if (active) setCodeEvaluation(null); });
    return () => { active = false; };
  }, []);

  const value = useMemo(() => ({
    dashboard,
    codeEvaluation,
    updateCodeEvaluation,
    people: dashboard.people || [],
    teams: dashboard.teams || [],
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
