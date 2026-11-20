import { createHmac, timingSafeEqual } from "node:crypto";
import { supabaseRest } from "./auth.js";

const RAZORPAY_API = "https://api.razorpay.com/v1";
const supabaseUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function billingConfig() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID?.trim() || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET?.trim() || "",
    planId: process.env.RAZORPAY_PLAN_ID?.trim() || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || "",
    signingSecret: process.env.COVAL_BILLING_SIGNING_SECRET?.trim() || "",
  };
}

export function requireBillingConfig() {
  const config = billingConfig();
  if (!config.keyId || !config.keySecret || !config.planId || !config.signingSecret) {
    throw Object.assign(new Error("Payments are not configured yet. Add the Razorpay and billing settings to the web app's environment."), { status: 503 });
  }
  return config;
}

export function safeEqualHex(expected, actual) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(actual || ""), "utf8");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export const hmacHex = (secret, payload) => createHmac("sha256", secret).update(payload).digest("hex");

export async function razorpay(path, init = {}) {
  const { keyId, keySecret } = requireBillingConfig();
  let response;
  try {
    response = await fetch(`${RAZORPAY_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Object.assign(new Error("COVAL could not reach Razorpay. Try again."), { status: 504 });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.error?.description || "Razorpay rejected the request."), { status: 502 });
  return payload;
}

// Razorpay subscription states mapped to COVAL plans. Cancelled keeps Pro until the period ends.
export function entitlementFor(subscription) {
  const status = String(subscription?.status || "").toLowerCase();
  const proStatuses = new Set(["authenticated", "active", "pending", "cancelled"]);
  return {
    plan: proStatuses.has(status) ? "pro" : "free",
    status: ["created", "authenticated", "active", "pending", "halted", "cancelled", "completed", "expired"].includes(status) ? status : "none",
    subscriptionId: subscription?.id || null,
    periodEnd: subscription?.current_end ? new Date(Number(subscription.current_end) * 1000).toISOString() : null,
  };
}

// Canonical string; must match coval_apply_entitlement in the billing migration exactly.
export function entitlementPayload(userId, { plan, status, subscriptionId, periodEnd }, issuedAt) {
  const periodSeconds = periodEnd ? String(Math.floor(new Date(periodEnd).getTime() / 1000)) : "";
  return [userId, plan, status, subscriptionId || "", periodSeconds, String(issuedAt)].join("|");
}

// Sends a signed plan change to Supabase. Works with a member's session or, for webhooks, anonymously.
export async function applyEntitlement(userId, entitlement, user = null) {
  const { signingSecret } = requireBillingConfig();
  const issuedAt = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    member: userId,
    new_plan: entitlement.plan,
    new_status: entitlement.status,
    subscription: entitlement.subscriptionId,
    period_end: entitlement.periodEnd,
    issued_at: issuedAt,
    signature: hmacHex(signingSecret, entitlementPayload(userId, entitlement, issuedAt)),
  });
  if (user?.token) return supabaseRest(user, "rpc/coval_apply_entitlement", { method: "POST", body });
  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/coval_apply_entitlement`, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: `Bearer ${supabaseKey()}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw Object.assign(new Error(payload?.message || "Could not store the billing update."), { status: 502 });
  }
  return true;
}

// True on Pro, or when billing is not set up yet (no paywall before the billing migration).
export async function hasPro(user) {
  if (!user?.token) return true;
  try {
    const summary = await supabaseRest(user, "rpc/coval_billing_summary", { method: "POST", body: "{}" });
    return summary?.plan === "pro";
  } catch (error) {
    if (error.status === 404 || /could not find the function/i.test(error.message || "")) return true;
    throw error;
  }
}

// Counts one use of a metered feature; turns the database's limit error into HTTP 402.
export async function consumeQuota(user, kind) {
  if (!user?.token) return null; // local development without a session
  try {
    return await supabaseRest(user, "rpc/coval_consume_quota", { method: "POST", body: JSON.stringify({ usage_kind: kind }) });
  } catch (error) {
    if (/limit reached/i.test(error.message || "")) throw Object.assign(new Error(error.message), { status: 402 });
    // Until the billing migration is applied the function does not exist; keep features working without limits.
    if (error.status === 404 || /could not find the function/i.test(error.message || "")) {
      console.warn("COVAL usage limits are off: apply supabase/migrations/202611200002_coval_billing.sql.");
      return null;
    }
    throw error;
  }
}
