import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { applyEntitlement, billingConfig, entitlementFor, hmacHex, razorpay, requireBillingConfig, safeEqualHex } from "../../lib/server/billing.js";

const FREE_SUMMARY = {
  plan: "free", status: "none", subscriptionId: null, currentPeriodEnd: null,
  usage: { evaluation: { used: 0, limit: 5 }, assistant: { used: 0, limit: 10 } },
};

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const config = billingConfig();
    const summary = user.token ? await supabaseRest(user, "rpc/coval_billing_summary", { method: "POST", body: "{}" }) : FREE_SUMMARY;
    return Response.json(
      { ...summary, checkoutAvailable: Boolean(config.keyId && config.keySecret && config.planId && config.signingSecret), signedIn: Boolean(user.token) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) throw Object.assign(new Error("Sign in to manage your plan."), { status: 401 });
    const body = await request.json().catch(() => ({}));
    const config = requireBillingConfig();

    if (body.action === "subscribe") {
      const summary = await supabaseRest(user, "rpc/coval_billing_summary", { method: "POST", body: "{}" });
      if (summary.plan === "pro" && summary.status !== "cancelled") throw Object.assign(new Error("You already have COVAL Pro."), { status: 409 });
      const subscription = await razorpay("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ plan_id: config.planId, total_count: 120, customer_notify: 1, notes: { coval_user_id: user.id } }),
      });
      await applyEntitlement(user.id, { plan: summary.plan, status: summary.plan === "pro" ? summary.status : "created", subscriptionId: subscription.id, periodEnd: null }, user);
      return Response.json({ subscriptionId: subscription.id, keyId: config.keyId });
    }

    if (body.action === "verify") {
      const { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature } = body;
      if (![paymentId, subscriptionId, signature].every((value) => typeof value === "string" && value.length < 200)) {
        throw Object.assign(new Error("Payment confirmation is incomplete."), { status: 400 });
      }
      if (!safeEqualHex(hmacHex(config.keySecret, `${paymentId}|${subscriptionId}`), signature)) {
        throw Object.assign(new Error("Payment signature did not match."), { status: 400 });
      }
      // Trust Razorpay's record of the subscription, and make sure it belongs to this member.
      const subscription = await razorpay(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
      if (subscription.notes?.coval_user_id !== user.id) throw Object.assign(new Error("This subscription belongs to another account."), { status: 403 });
      const entitlement = entitlementFor(subscription);
      await applyEntitlement(user.id, entitlement, user);
      return Response.json({ plan: entitlement.plan, status: entitlement.status });
    }

    if (body.action === "cancel") {
      const summary = await supabaseRest(user, "rpc/coval_billing_summary", { method: "POST", body: "{}" });
      if (!summary.subscriptionId) throw Object.assign(new Error("There is no subscription to cancel."), { status: 400 });
      const subscription = await razorpay(`/subscriptions/${encodeURIComponent(summary.subscriptionId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ cancel_at_cycle_end: 1 }),
      });
      // Razorpay keeps cycle-end cancellations "active" until the period ends; record the intent now.
      const entitlement = { ...entitlementFor(subscription), plan: "pro", status: "cancelled" };
      await applyEntitlement(user.id, entitlement, user);
      return Response.json({ plan: "pro", status: "cancelled", currentPeriodEnd: entitlement.periodEnd });
    }

    throw Object.assign(new Error("Unknown billing action."), { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
