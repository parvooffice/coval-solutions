import { applyEntitlement, billingConfig, entitlementFor, hmacHex, safeEqualHex } from "../../../lib/server/billing.js";

// Razorpay webhook: keeps plans in sync when subscriptions renew, fail, or end.
// Configure in Razorpay Dashboard → Webhooks with the subscription.* events below.
const HANDLED = new Set([
  "subscription.authenticated", "subscription.activated", "subscription.charged", "subscription.pending",
  "subscription.halted", "subscription.cancelled", "subscription.completed",
]);

export async function POST(request) {
  const { webhookSecret, signingSecret } = billingConfig();
  if (!webhookSecret || !signingSecret) return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 256 * 1024) return Response.json({ error: "Payload too large." }, { status: 413 });
  if (!safeEqualHex(hmacHex(webhookSecret, raw), request.headers.get("x-razorpay-signature"))) {
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }
  let event;
  try { event = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!HANDLED.has(event?.event)) return Response.json({ ignored: true });

  const subscription = event.payload?.subscription?.entity;
  const userId = subscription?.notes?.coval_user_id;
  if (!subscription?.id || !/^[0-9a-f-]{36}$/i.test(userId || "")) return Response.json({ ignored: true, reason: "No COVAL member on this subscription." });
  try {
    const entitlement = entitlementFor(subscription);
    // A cycle-end cancellation still reports "active"; an explicit cancelled event keeps Pro until current_end.
    if (event.event === "subscription.cancelled") Object.assign(entitlement, { plan: "pro", status: "cancelled" });
    await applyEntitlement(userId, entitlement);
    return Response.json({ received: true });
  } catch (error) {
    // A 5xx makes Razorpay retry later.
    return Response.json({ error: error.message || "Could not apply the billing update." }, { status: 500 });
  }
}
