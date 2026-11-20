import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { EvaluationTarget, formatScore, gradeFor, overallScore } from "./evaluation-report";

// Public, read-only report at /report/<token> (or /report/sample). No sign-in needed.
export default function SharedReportPage({ token }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const isSample = token === "sample";

  useEffect(() => {
    const source = isSample ? "/sample-report.json" : `/api/share?token=${encodeURIComponent(token)}`;
    fetch(source, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "This report could not be loaded.");
        setReport(isSample ? body : body.report);
      })
      .catch((cause) => setError(cause.message));
  }, [token, isSample]);

  useEffect(() => {
    if (!report) return;
    const overall = overallScore(report.evaluations);
    document.title = `${report.name} · COVAL ${formatScore(overall)} (${gradeFor(overall)})`;
  }, [report]);

  const origin = window.location.origin;
  const markdown = `[![COVAL score](${origin}/api/badge?token=${token})](${origin}/report/${token})`;

  return <div className="shared-report">
    <header className="shared-report-bar">
      <a href="/" className="shared-report-brand"><img src="/coval-logo-dark.png" alt="" width="28" height="28" /> COVAL</a>
      <nav>
        <a href="/pricing.html">Pricing</a>
        <a href="/privacy.html">Privacy</a>
        <a className="button button-primary" href="/">Score your repository</a>
      </nav>
    </header>
    <main className="shared-report-main">
      {error && <div className="empty-state surface-card"><Icon name="info" size={22} /><strong>{error}</strong><p>Ask the owner for a new link, or <a href="/report/sample">see a sample report</a>.</p></div>}
      {!report && !error && <div className="empty-state"><Icon name="activity" size={22} /><strong>Loading report…</strong></div>}
      {report && <>
        <div className="shared-report-intro">
          <span className="eyebrow">{isSample ? "SAMPLE REPORT" : "SHARED REPORT"}</span>
          <h1>Code health for {report.name}</h1>
          <p>{isSample ? "A real COVAL report for a popular open-source project. " : ""}Ten automated agents scored this repository for documentation, modularity, security, error handling, readability, test coverage, performance, maintainability, scalability, and standards.</p>
        </div>
        <EvaluationTarget
          target={{ ...report, input: report.url, source: "github" }}
          eyebrow={report.sharedBy ? `SHARED BY ${report.sharedBy.startsWith("COVAL") ? report.sharedBy.toUpperCase() : `@${report.sharedBy.toUpperCase()}`}` : "GITHUB REPOSITORY"}
          meta={report.generatedAt ? `Evaluated ${new Date(report.generatedAt).toLocaleString()}` : ""}
          actions={<button type="button" className="button button-quiet no-print" onClick={() => window.print()}><Icon name="arrowDown" size={14} /> Download PDF</button>}
        />
        {!isSample && <section className="shared-report-badge surface-card no-print">
          <div><strong>Add this score to your README</strong><p>The badge updates when the owner re-shares a newer evaluation.</p></div>
          <img src={`/api/badge?token=${encodeURIComponent(token)}`} alt="COVAL score badge" height="20" />
          <div className="shared-report-copy"><code>{markdown}</code><button type="button" className="button button-quiet" onClick={() => navigator.clipboard?.writeText(markdown).then(() => setCopied(true))}>{copied ? "Copied" : "Copy Markdown"}</button></div>
        </section>}
        <section className="shared-report-cta surface-card no-print">
          <div><strong>How does your code compare?</strong><p>Sign in with GitHub or Google and score up to 5 repositories a month for free.</p></div>
          <a className="button button-primary" href="/">Score my repository <Icon name="arrowRight" size={14} /></a>
        </section>
      </>}
    </main>
  </div>;
}
