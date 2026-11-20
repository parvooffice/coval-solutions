import { useCallback, useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { PageHeading } from "./ui";
import { apiRequest } from "../lib/client-api";

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
const FEATURES = [
  ["Evaluation runs per month", "5", "Unlimited"],
  ["Code-review agents per run", "All 10", "All 10"],
  ["Report assistant questions per month", "10", "300"],
  ["Create and manage teams", "—", "Yes"],
  ["Join teams you're invited to", "Yes", "Yes"],
  ["Score history and top fixes", "Yes", "Yes"],
];

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay checkout could not load. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

function Meter({ label, used, limit }) {
  const unlimited = limit == null;
  const share = unlimited ? 0 : Math.min(100, (used / Math.max(limit, 1)) * 100);
  return <div className="billing-meter">
    <div><span>{label}</span><strong>{used}{unlimited ? "" : ` / ${limit}`}</strong></div>
    <div className="billing-meter-track"><span className={share >= 100 ? "is-full" : share >= 80 ? "is-high" : ""} style={{ width: unlimited ? "100%" : `${share}%` }} data-unlimited={unlimited || undefined} /></div>
    <small>{unlimited ? "Unlimited on Pro" : share >= 100 ? "Limit reached for this month" : `${limit - used} left this month`}</small>
  </div>;
}

export default function BillingPage({ notify }) {
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setSummary(await apiRequest("/api/billing"));
      setError("");
    } catch (cause) {
      setError(cause.message || "Could not load your plan.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function upgrade() {
    setBusy("upgrade");
    setError("");
    try {
      const [{ subscriptionId, keyId }] = await Promise.all([apiRequest("/api/billing", { method: "POST", body: JSON.stringify({ action: "subscribe" }) }), loadCheckout()]);
      await new Promise((resolve, reject) => {
        const checkout = new window.Razorpay({
          key: keyId,
          subscription_id: subscriptionId,
          name: "COVAL Solutions",
          description: "COVAL Pro monthly",
          theme: { color: "#64806a" },
          handler: async (response) => {
            try {
              await apiRequest("/api/billing", { method: "POST", body: JSON.stringify({ action: "verify", ...response }) });
              notify?.("Welcome to COVAL Pro.");
              resolve();
            } catch (cause) { reject(cause); }
          },
          modal: { ondismiss: () => resolve() },
        });
        checkout.on("payment.failed", (event) => reject(new Error(event?.error?.description || "The payment did not go through.")));
        checkout.open();
      });
    } catch (cause) {
      setError(cause.message || "The upgrade did not complete.");
    } finally {
      setBusy("");
      load();
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel COVAL Pro? You keep Pro until the end of the current billing period.")) return;
    setBusy("cancel");
    setError("");
    try {
      await apiRequest("/api/billing", { method: "POST", body: JSON.stringify({ action: "cancel" }) });
      notify?.("Your subscription will end at the close of this billing period.");
    } catch (cause) {
      setError(cause.message || "The cancellation did not go through.");
    } finally {
      setBusy("");
      load();
    }
  }

  async function deleteData() {
    if (!window.confirm("Delete all your saved evaluation reports, dismissed findings, and share links? This cannot be undone.")) return;
    setBusy("delete");
    setError("");
    try {
      await apiRequest("/api/code-evaluation", { method: "DELETE" });
      notify?.("Your evaluation data was deleted.");
    } catch (cause) {
      setError(cause.message || "Your data could not be deleted.");
    } finally {
      setBusy("");
    }
  }

  const isPro = summary?.plan === "pro";
  const cancelled = summary?.status === "cancelled";
  // Early access hides upgrade and cancel, unless the member already has a paid subscription to manage.
  const earlyAccess = Boolean(summary?.earlyAccess) && !summary?.subscriptionId;
  const periodEnd = summary?.currentPeriodEnd ? new Date(summary.currentPeriodEnd).toLocaleDateString() : "";
  const resets = summary?.resetsAt ? new Date(summary.resetsAt).toLocaleDateString() : "the 1st of next month";

  return <>
    <PageHeading eyebrow="COVAL / PLAN" title="Plan & usage" description="See what you've used this month and upgrade when you need more." />
    {error && <div className="backend-status-banner" role="alert"><div><strong>Billing needs attention.</strong><p>{error}</p></div><button type="button" className="button" onClick={() => setError("")}>Dismiss</button></div>}

    <section className="billing-current surface-card">
      <div>
        <span className="eyebrow">CURRENT PLAN</span>
        <h2>{summary ? (isPro ? "COVAL Pro" : "Free") : "Loading…"} {isPro && <span className="billing-badge">PRO</span>}</h2>
        <p>{earlyAccess
          ? "Early access: every Pro feature is free for all members while COVAL is in early access."
          : isPro
            ? cancelled ? `Cancelled. Pro stays active until ${periodEnd || "the end of this period"}.` : `Renews automatically${periodEnd ? ` on ${periodEnd}` : ""}.`
            : `Usage resets on ${resets}.`}</p>
      </div>
      {summary && !earlyAccess && <div className="billing-actions">
        {(!isPro || cancelled) && <button type="button" className="button button-primary" onClick={upgrade} disabled={Boolean(busy) || !summary.signedIn || !summary.checkoutAvailable}><Icon name="star" size={15} /> {busy === "upgrade" ? "Opening checkout…" : cancelled ? "Resubscribe to Pro" : "Upgrade to Pro"}</button>}
        {isPro && !cancelled && <button type="button" className="button button-quiet team-danger" onClick={cancel} disabled={Boolean(busy)}>{busy === "cancel" ? "Cancelling…" : "Cancel subscription"}</button>}
        {!summary.signedIn && <small>Sign in to upgrade.</small>}
        {summary.signedIn && !summary.checkoutAvailable && <small>Payments aren't switched on yet.</small>}
      </div>}
    </section>

    {summary && <section className="billing-usage surface-card" aria-label="Usage this month">
      <span className="eyebrow">THIS MONTH</span>
      <div className="billing-meters">
        <Meter label="Evaluation runs" used={summary.usage?.evaluation?.used || 0} limit={summary.usage?.evaluation?.limit ?? null} />
        <Meter label="Assistant questions" used={summary.usage?.assistant?.used || 0} limit={summary.usage?.assistant?.limit ?? null} />
      </div>
    </section>}

    <section className="billing-compare surface-card" aria-label="Compare plans">
      <span className="eyebrow">COMPARE PLANS</span>
      <table>
        <thead><tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Pro</th></tr></thead>
        <tbody>{FEATURES.map(([feature, free, pro]) => <tr key={feature}><th scope="row">{feature}</th><td>{free}</td><td>{pro}</td></tr>)}</tbody>
      </table>
      <p className="team-muted"><a href="/pricing.html" target="_blank" rel="noreferrer">Full pricing and FAQ</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
      <p className="team-muted">Payments are handled securely by Razorpay (UPI, cards, netbanking). COVAL never sees your card details. The Pro price is shown in the checkout.</p>
    </section>

    {summary?.signedIn && <section className="billing-compare surface-card" aria-label="Your data">
      <span className="eyebrow">YOUR DATA</span>
      <p className="team-muted">Source code is deleted right after each run. Your saved scores, findings, and share links stay until you delete them.</p>
      <div><button type="button" className="button button-quiet team-danger" disabled={Boolean(busy)} onClick={deleteData}>{busy === "delete" ? "Deleting…" : "Delete my evaluation data"}</button></div>
    </section>}
  </>;
}
