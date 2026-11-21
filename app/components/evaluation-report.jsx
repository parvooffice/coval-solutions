import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { apiRequest } from "../lib/client-api";

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

export const findingKey = (target, evaluation, fix) => [target.url || target.input, evaluation.id, fix.title, fix.location || ""].join("|");

function githubIssueUrl(target, evaluation, fix) {
  if (!target.url?.startsWith("https://github.com/")) return "";
  const location = fix.location ? fix.location.match(/^(.*?)(?::(\d+))?$/) : null;
  const link = location ? `${target.url}/blob/${target.ref || "HEAD"}/${location[1]}${location[2] ? `#L${location[2]}` : ""}` : "";
  const body = [
    `**${evaluation.label}** finding from a COVAL code review.`,
    "",
    fix.detail || "",
    link ? `\nLocation: ${link}` : "",
    "",
    `Agent score: ${formatScore(evaluation.score)}/100`,
  ].join("\n");
  return `${target.url}/issues/new?${new URLSearchParams({ title: `[COVAL] ${fix.title}`.slice(0, 200), body: body.slice(0, 4000) })}`;
}

// Light Markdown for AI answers: bold, numbered or bulleted lists, code fences, and inline code.
function MarkdownText({ text }) {
  const inline = (line) => line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((piece, index) => piece.startsWith("`")
    ? <code key={index}>{piece.slice(1, -1)}</code>
    : piece.startsWith("**") ? <strong key={index}>{piece.slice(2, -2)}</strong> : piece);
  return text.split(/```[a-z0-9]*\n?/i).map((part, index) => index % 2
    ? <pre key={index}><code>{part.replace(/\n$/, "")}</code></pre>
    : part.split(/\n{2,}/).filter((block) => block.trim()).map((block, blockIndex) => {
      const lines = block.split("\n").filter(Boolean);
      if (lines.every((line) => /^\s*([-*]|\d+\.)\s/.test(line))) return <ol key={`${index}-${blockIndex}`}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>)}</ol>;
      return <p key={`${index}-${blockIndex}`}>{lines.map((line, lineIndex) => <span key={lineIndex}>{inline(line)}{lineIndex < lines.length - 1 && <br />}</span>)}</p>;
    }));
}

function FixItem({ target, evaluation, fix, onDismiss, helpRequest, onAskHelp }) {
  const [explanation, setExplanation] = useState("");
  const [state, setState] = useState("idle");
  const [asking, setAsking] = useState(false);
  const [askNote, setAskNote] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const issueUrl = githubIssueUrl(target, evaluation, fix);
  async function submitAsk(event) {
    event.preventDefault();
    setAskBusy(true);
    const ok = await onAskHelp(target, evaluation, fix, askNote);
    setAskBusy(false);
    if (ok) { setAsking(false); setAskNote(""); }
  }
  async function explain() {
    if (state === "done") { setState("hidden"); return; }
    if (state === "hidden" && explanation) { setState("done"); return; }
    setState("loading");
    try {
      const { answer } = await apiRequest("/api/explain-finding", { method: "POST", body: JSON.stringify({ targetUrl: target.url, agent: evaluation.label, title: fix.title, detail: fix.detail, location: fix.location }) });
      setExplanation(answer);
      setState("done");
    } catch (error) {
      setExplanation(error.message || "The explanation could not be loaded.");
      setState("error");
    }
  }
  return <li>
    <strong>{fix.title}</strong>
    {fix.location && <code>{fix.location}</code>}
    {fix.detail && <small>{fix.detail}</small>}
    {onDismiss && <div className="eval-fix-actions">
      <button type="button" onClick={explain} disabled={state === "loading"}><Icon name="smile" size={13} /> {state === "loading" ? "Thinking…" : state === "done" ? "Hide explanation" : "Explain & fix"}</button>
      {issueUrl && <a href={issueUrl} target="_blank" rel="noreferrer"><Icon name="git" size={13} /> Create issue</a>}
      {onAskHelp && target.source === "github" && (helpRequest
        ? <a href="/dashboard#feed" className="eval-help-badge"><Icon name="users" size={13} /> Help requested · {helpRequest.interestCount} {helpRequest.interestCount === 1 ? "offer" : "offers"}</a>
        : <button type="button" onClick={() => setAsking(!asking)}><Icon name="users" size={13} /> Ask for help</button>)}
      <button type="button" onClick={() => onDismiss(findingKey(target, evaluation, fix))}><Icon name="x" size={13} /> Dismiss</button>
    </div>}
    {asking && <form className="eval-ask-help" onSubmit={submitAsk}>
      <small>Posts this finding to <strong>Issues to solve</strong> in the Feed, linked to the exact code. Anyone can offer to help; you choose who.</small>
      <textarea value={askNote} onChange={(event) => setAskNote(event.target.value)} maxLength={2000} rows={2} placeholder="Optional: context, what you've tried, or what kind of help you need" aria-label="Help request details" />
      <div><button type="button" onClick={() => setAsking(false)}>Cancel</button><button type="submit" className="is-primary" disabled={askBusy}>{askBusy ? "Posting…" : "Post help request"}</button></div>
    </form>}
    {(state === "done" || state === "error") && <div className={`eval-fix-explanation ${state === "error" ? "is-error" : ""}`}><MarkdownText text={explanation} /></div>}
  </li>;
}

function AgentCard({ target, evaluation, before, showFixes, dismissed, onDismiss, onRestore, helpRequests, onAskHelp }) {
  const complete = evaluation.status === "complete";
  const grade = complete ? evaluation.grade || gradeFor(evaluation.score) : "";
  const allFixes = showFixes ? evaluation.fixes || [] : [];
  const fixes = allFixes.filter((fix) => !dismissed?.has(findingKey(target, evaluation, fix)));
  const hidden = allFixes.filter((fix) => dismissed?.has(findingKey(target, evaluation, fix)));
  return <article className={`evaluation-score-card ${complete ? "" : "is-failed"}`}>
    <div className="evaluation-score-heading"><span>{evaluation.label}</span><Icon name={ICONS[evaluation.id] || "code"} size={17} /></div>
    <div className="eval-score-row">
      <strong className="evaluation-score-value">{formatScore(evaluation.score)}<small>/100</small></strong>
      <Delta current={evaluation.score} before={before} />
    </div>
    <span className={`evaluation-status evaluation-status-${evaluation.status} ${grade ? `eval-grade-${grade}` : ""}`}>{complete ? `Grade ${grade}` : "Unavailable"}</span>
    <p>{evaluation.summary || evaluation.error || "No summary was provided by the analyzer."}</p>
    {(fixes.length > 0 || hidden.length > 0) && <div className="eval-fixes">
      <span className="eval-fixes-title">Top fixes</span>
      {fixes.length > 0 && <ol>{fixes.map((item, index) => <FixItem key={`${item.title}-${item.location}-${index}`} target={target} evaluation={evaluation} fix={item} onDismiss={onDismiss} helpRequest={helpRequests?.get(findingKey(target, evaluation, item))} onAskHelp={onAskHelp} />)}</ol>}
      {hidden.length > 0 && <details className="eval-dismissed"><summary>{hidden.length} dismissed</summary><ul>{hidden.map((item, index) => <li key={index}><span>{item.title}</span>{onRestore && <button type="button" onClick={() => onRestore(findingKey(target, evaluation, item))}>Restore</button>}</li>)}</ul></details>}
    </div>}
    {evaluation.breakdown && Object.keys(evaluation.breakdown).length > 0 && <details className="evaluation-breakdown">
      <summary>Score breakdown</summary>
      <dl>{Object.entries(evaluation.breakdown).map(([key, value]) => <div key={key}><dt>{(typeof value === "object" && value.label) || key.replaceAll("_", " ")}</dt><dd>{formatScore(typeof value === "object" ? value.score : value)}</dd></div>)}</dl>
    </details>}
  </article>;
}

function Trend({ history, current }) {
  const points = [...(history || []).map((item) => item.overall), current].filter((value) => typeof value === "number");
  if (points.length < 2) return null;
  const min = Math.min(...points) - 5;
  const span = Math.max(Math.max(...points) + 5 - min, 1);
  const path = points.map((value, index) => `${index ? "L" : "M"}${(index / (points.length - 1)) * 100},${30 - ((value - min) / span) * 28}`).join(" ");
  return <span className="eval-trend" title={`Overall over the last ${points.length} runs: ${points.map(formatScore).join(" → ")}`}>
    <svg viewBox="-2 0 104 32" aria-hidden="true"><path d={path} /></svg>
    <small>{points.length} runs</small>
  </span>;
}

export function EvaluationTarget({ target, eyebrow, meta, showFixes = true, dismissed, onDismiss, onRestore, actions, helpRequests, onAskHelp }) {
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
        <p className="eval-overall-line">Overall {formatScore(overall)}/100 <Delta current={overall} before={before} />{target.previous?.generatedAt && <small> vs {new Date(target.previous.generatedAt).toLocaleDateString()}</small>}{failed > 0 && <small> · {failed} {failed === 1 ? "agent" : "agents"} unavailable</small>}<Trend history={target.history} current={overall} /></p>
        {target.ignoredFiles > 0 && <p className="eval-ignored-note">{target.ignoredFiles} generated or ignored files were skipped. Add paths to <code>.coval.yml</code> under <code>ignore:</code> to skip more.</p>}
      </div>
      {actions}
      {target.url?.startsWith("https://github.com/") && <a className="button" href={target.url} target="_blank" rel="noreferrer">Open repository <Icon name="arrowUpRight" size={14} /></a>}
    </header>
    <div className="evaluation-score-grid">
      {(target.evaluations || []).map((evaluation) => <AgentCard key={evaluation.id} target={target} evaluation={evaluation} before={target.previous?.scores?.[evaluation.id]} showFixes={showFixes} dismissed={dismissed} onDismiss={onDismiss} onRestore={onRestore} helpRequests={helpRequests} onAskHelp={onAskHelp} />)}
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
