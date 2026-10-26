import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

export function getBrowserSupabase() {
  if (typeof window === "undefined") return null;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error("Add the Supabase URL and publishable key to .env.");
  if (!window.covalSupabase) window.covalSupabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return window.covalSupabase;
}
