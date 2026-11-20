import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";

export const AGENTS = [
  { id: "documentation", label: "Documentation", icon: "list" },
  { id: "modularity", label: "Modularity", icon: "grid" },
  { id: "security", label: "Security", icon: "lock" },
  { id: "error_handling", label: "Error handling", icon: "info" },
  { id: "readability", label: "Readability", icon: "eye" },
  { id: "test_coverage", label: "Test coverage", icon: "flask" },
  { id: "performance", label: "Performance", icon: "activity" },
  { id: "maintainability", label: "Maintainability", icon: "settings" },
  { id: "scalability", label: "Scalability", icon: "network" },
  { id: "standards", label: "Standards compliance", icon: "check" },
];
const ICONS = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.icon]));

export function formatScore(value) {
  return value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(1).replace(/\.0$/, "");
}

// One letter scale for every agent, so cards are comparable even when an analyzer reports no grade.
export function gradeFor(score) {
  if (score == null) return "";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function overallScore(evaluations = []) {
  const scores = evaluations.filter((item) => item.status === "complete" && item.score != null).map((item) => Number(item.score));
  return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
}

function previousOverall(previous) {
  const values = Object.values(previous?.scores || {}).map(Number).filter((value) => !Number.isNaN(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function Delta({ current, before }) {
  if (current == null || before == null) return null;
  const change = Number(current) - Number(before);
  if (Math.abs(change) < 0.05) return <span className="eval-delta is-flat" title="Unchanged since the last run">±0</span>;
  return <span className={`eval-delta ${change > 0 ? "is-up" : "is-down"}`} title={`Was ${formatScore(before)} in the last run`}>{change > 0 ? "▲" : "▼"} {formatScore(Math.abs(change))}</span>;
}

function ScoreRing({ score }) {
  const value = score == null ? 0 : Math.max(0, Math.min(100, score));
  const circumference = 2 * Math.PI * 34;
  return <div className={`eval-ring eval-grade-${gradeFor(score) || "none"}`} role="img" aria-label={score == null ? "No overall score" : `Overall score ${formatScore(score)} out of 100`}>
    <svg viewBox="0 0 80 80" aria-hidden="true">
      <circle cx="40" cy="40" r="34" className="eval-ring-track" />
      <circle cx="40" cy="40" r="34" className="eval-ring-value" strokeDasharray={`${(value / 100) * circumference} ${circumference}`} />
    </svg>
    <span><strong>{formatScore(score)}</strong><small>{gradeFor(score) || "—"}</small></span>
  </div>;
}

function AgentCard({ evaluation, before, showFixes }) {
  const complete = evaluation.status === "complete";
  const grade = complete ? evaluation.grade || gradeFor(evaluation.score) : "";
  const fixes = showFixes ? evaluation.fixes || [] : [];
  return <article className={`evaluation-score-card ${complete ? "" : "is-failed"}`}>
    <div className="evaluation-score-heading"><span>{evaluation.label}</span><Icon name={ICONS[evaluation.id] || "code"} size={17} /></div>
    <div className="eval-score-row">
      <strong className="evaluation-score-value">{formatScore(evaluation.score)}<small>/100</small></strong>
      <Delta current={evaluation.score} before={before} />
    </div>
    <span className={`evaluation-status evaluation-status-${evaluation.status} ${grade ? `eval-grade-${grade}` : ""}`}>{complete ? `Grade ${grade}` : "Unavailable"}</span>
    <p>{evaluation.summary || evaluation.error || "No summary was provided by the analyzer."}</p>
    {fixes.length > 0 && <div className="eval-fixes">
      <span className="eval-fixes-title">Top fixes</span>
      <ol>{fixes.map((item, index) => <li key={`${item.title}-${index}`}>
        <strong>{item.title}</strong>
        {item.location && <code>{item.location}</code>}
        {item.detail && <small>{item.detail}</small>}
      </li>)}</ol>
    </div>}
    {evaluation.breakdown && Object.keys(evaluation.breakdown).length > 0 && <details className="evaluation-breakdown">
      <summary>Score breakdown</summary>
      <dl>{Object.entries(evaluation.breakdown).map(([key, value]) => <div key={key}><dt>{(typeof value === "object" && value.label) || key.replaceAll("_", " ")}</dt><dd>{formatScore(typeof value === "object" ? value.score : value)}</dd></div>)}</dl>
    </details>}
  </article>;
}

export function EvaluationTarget({ target, eyebrow, meta, showFixes = true }) {
  const overall = overallScore(target.evaluations);
  const before = previousOverall(target.previous);
  const failed = (target.evaluations || []).filter((item) => item.status !== "complete").length;
  return <section className="evaluation-target-card surface-card">
    <header className="eval-target-header">
      <ScoreRing score={overall} />
      <div className="eval-target-title">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{target.name}</h2>
        <p className="evaluation-target-meta">{meta}</p>
        <p className="eval-overall-line">Overall {formatScore(overall)}/100 <Delta current={overall} before={before} />{target.previous?.generatedAt && <small> vs {new Date(target.previous.generatedAt).toLocaleDateString()}</small>}{failed > 0 && <small> · {failed} {failed === 1 ? "agent" : "agents"} unavailable</small>}</p>
      </div>
      {target.url?.startsWith("https://github.com/") && <a className="button" href={target.url} target="_blank" rel="noreferrer">Open repository <Icon name="arrowUpRight" size={14} /></a>}
    </header>
    <div className="evaluation-score-grid">
      {(target.evaluations || []).map((evaluation) => <AgentCard key={evaluation.id} evaluation={evaluation} before={target.previous?.scores?.[evaluation.id]} showFixes={showFixes} />)}
    </div>
  </section>;
}

// Shown while a run is in progress. The analyzers report back once at the end,
// so this shows elapsed time and which agents are running, not fake per-agent progress.
export function RunProgress({ repositories }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, "0");
  return <div className="eval-progress" role="status" aria-live="polite">
    <div className="eval-progress-head">
      <span className="eval-spinner" aria-hidden="true" />
      <strong>Running {AGENTS.length} agents on {repositories} {repositories === 1 ? "repository" : "repositories"}</strong>
      <span className="eval-progress-time">{minutes}:{seconds}</span>
    </div>
    <ul>{AGENTS.map((agent) => <li key={agent.id}><Icon name={agent.icon} size={14} />{agent.label}<span className="eval-progress-pulse" /></li>)}</ul>
    <p>The agents run side by side in the cloud. Most repositories finish in under two minutes; larger ones can take up to five.</p>
  </div>;
}
