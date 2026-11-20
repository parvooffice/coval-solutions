import { randomBytes } from "node:crypto";
import { hasValidPublicSignature } from "./evaluation-sharing.js";

const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
export const newShareToken = () => randomBytes(18).toString("base64url");

// Public view of one repository: scores, grades, summaries, breakdowns, top fixes, and history.
export function shareSnapshot(target) {
  return {
    name: target.name,
    url: target.url,
    generatedAt: target.generatedAt || null,
    history: Array.isArray(target.history) ? target.history.slice(-11) : [],
    evaluations: (target.evaluations || []).map(({ id, label, status, score, grade, summary, breakdown, fixes }) => ({
      id, label, status, score: score ?? null, grade: grade || null, summary: summary || "", breakdown: breakdown || {}, fixes: Array.isArray(fixes) ? fixes.slice(0, 3) : [],
    })),
  };
}

// Loads a shared report without a session and returns it only if the server's signature checks out.
export async function loadSharedReport(token) {
  if (!TOKEN_PATTERN.test(token || "")) return null;
  if (!supabaseUrl() || !supabaseKey()) throw Object.assign(new Error("Shared reports are not configured."), { status: 503 });
  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/coval_get_shared_report`, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: `Bearer ${supabaseKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ share_token: token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error("Could not load this shared report."), { status: 502 });
  const [row] = await response.json();
  if (!row) return null;
  const valid = hasValidPublicSignature({ user_id: row.user_id, github_login: row.github_login, public_report: row.snapshot, public_signature: row.signature });
  return valid ? { ...row.snapshot, sharedBy: row.github_login || "", sharedAt: row.created_at } : null;
}
