"use client";

import { useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";

const MAX_TARGETS = 5;

function number(value) {
  return value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(1).replace(/\.0$/, "");
}

function parseUrlText(value) {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean))];
}

function parseUrlFile(value) {
  return [...new Set(value.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).flatMap((line) => line.split(/[\s,;]+/)).map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter((item) => /^https:\/\/github\.com\//i.test(item)))];
}

export default function CodeEvaluationPage() {
  const { codeEvaluation, projects, updateCodeEvaluation } = useDashboardData();
  const [urlText, setUrlText] = useState("");
  const [running, setRunning] = useState(false);
  const [importingRepositories, setImportingRepositories] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runError, setRunError] = useState("");
  const fileInput = useRef(null);
  const targets = codeEvaluation?.targets || [];

  function importWorkspaceRepositories() {
    const allLoadedUrls = [...new Set(projects.map((project) => project.url).filter((url) => url?.startsWith("https://github.com/")))];
    const loadedUrls = allLoadedUrls.slice(0, MAX_TARGETS);
    if (!loadedUrls.length) {
      setRunError("No GitHub repositories are loaded yet. Connect a GitHub workspace or paste repository URLs below.");
      setRunMessage("");
      return;
    }
    const current = parseUrlText(urlText);
    const remaining = Math.max(0, MAX_TARGETS - current.length);
    if (!remaining) {
      setRunError(`This run already has ${MAX_TARGETS} URLs. Remove one before importing another repository.`);
      setRunMessage("");
      return;
    }
    const toAdd = loadedUrls.filter((url) => !current.includes(url)).slice(0, remaining);
    setUrlText([...current, ...toAdd].join("\n"));
    setRunError("");
    setRunMessage(`Added ${toAdd.length} of ${allLoadedUrls.length} connected workspace repositories. You can edit the list before scoring.`);
  }

  async function importMyGitHubRepositories() {
    setImportingRepositories(true);
    setRunError("");
    setRunMessage("");
    try {
      const { repositories } = await apiRequest("/api/github-repositories");
      if (!repositories.length) {
        setRunError("No public repositories were found for the signed-in GitHub account.");
        return;
      }
      const current = parseUrlText(urlText);
      const newUrls = repositories.map((repository) => repository.url).filter((url) => !current.includes(url));
      const remaining = Math.max(0, MAX_TARGETS - current.length);
      if (!remaining) {
        setRunError(`This run already has ${MAX_TARGETS} URLs. Remove one before importing another repository.`);
        return;
      }
      const added = newUrls.slice(0, remaining);
      setUrlText([...current, ...added].join("\n"));
      setRunMessage(`Imported ${added.length} of ${repositories.length} public repositories from GitHub. You can edit the list before scoring.`);
    } catch (error) {
      setRunError(error.message || "GitHub could not load your repositories.");
    } finally {
      setImportingRepositories(false);
    }
  }

  async function importUrlFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = parseUrlFile(await file.text());
      if (!imported.length) {
        setRunError("No repository URLs were found in that file.");
        setRunMessage("");
        return;
      }
      const current = parseUrlText(urlText);
      const remaining = Math.max(0, MAX_TARGETS - current.length);
      const toAdd = imported.filter((url) => !current.includes(url)).slice(0, remaining);
      if (!toAdd.length) {
        setRunError(`This run already has ${MAX_TARGETS} URLs. Remove one before importing a URL file.`);
        setRunMessage("");
        return;
      }
      setUrlText([...current, ...toAdd].join("\n"));
      setRunError("");
      setRunMessage(`Imported ${toAdd.length} of ${imported.length} URLs from ${file.name}. Remove some URLs and import again to evaluate a larger list.`);
    } catch {
      setRunError("This URL file could not be read.");
      setRunMessage("");
    } finally {
      event.target.value = "";
    }
  }

  async function runEvaluation(event) {
    event.preventDefault();
    const urls = parseUrlText(urlText);
    setRunError("");
    setRunMessage("");
    if (!urls.length) {
      setRunError("Paste at least one GitHub repository URL first.");
      return;
    }
    if (urls.length > MAX_TARGETS) {
      setRunError(`This run has ${urls.length} URLs. Choose up to ${MAX_TARGETS} repositories per run.`);
      return;
    }

    setRunning(true);
    try {
      const result = await apiRequest("/api/code-evaluation", { method: "POST", body: JSON.stringify({ urls }) });
      updateCodeEvaluation(result.report);
      setUrlText(urls.join("\n"));
      setRunMessage(`Evaluation complete for ${result.report.targets.length} ${result.report.targets.length === 1 ? "repository" : "repositories"}. All four scores are shown below and on Overview.`);
    } catch (error) {
      setRunError(error.message || "The analyzers could not finish this run.");
    } finally {
      setRunning(false);
    }
  }

  function downloadScores() {
    if (!codeEvaluation) return;
    const blob = new Blob([`${JSON.stringify(codeEvaluation, null, 2)}\n`], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `coval-code-evaluation-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }

  return <>
    <PageHeading
      eyebrow="DOCUMENTATION / MODULARITY / SECURITY / ERROR HANDLING"
      title="Code evaluation"
      description="Import repositories from this GitHub workspace or paste repository URLs. Your existing analyzers score each project across all four factors."
      action={<button type="button" className="button button-quiet" onClick={downloadScores} disabled={!codeEvaluation?.targets?.length}><Icon name="arrowDown" size={15} /> Download JSON</button>}
    />

    <form className="evaluation-import-card surface-card" onSubmit={runEvaluation}>
      <div className="evaluation-import-heading"><div><span className="eyebrow">GITHUB WORKSPACE / REPOSITORY INPUT</span><h2>Choose projects to score</h2><p>Paste one GitHub repository URL per line, or import a .txt/.csv URL list. Up to {MAX_TARGETS} projects per run.</p></div></div>
      <label className="evaluation-url-label" htmlFor="evaluation-repository-urls">Repository URLs</label>
      <textarea id="evaluation-repository-urls" className="evaluation-url-input" value={urlText} onChange={(event) => setUrlText(event.target.value)} placeholder={"https://github.com/owner/project-one\nhttps://github.com/owner/project-two"} rows={5} spellCheck="false" />
      <div className="evaluation-import-actions">
        <div className="evaluation-import-secondary-actions">
          <button type="button" className="button button-quiet" onClick={importMyGitHubRepositories} disabled={importingRepositories || running}><Icon name="git" size={15} /> {importingRepositories ? "Loading GitHub…" : "Import my public repos"}</button>
          <button type="button" className="button button-quiet" onClick={importWorkspaceRepositories} disabled={!projects.length || running}><Icon name="repo" size={15} /> Add loaded workspace repos ({projects.length})</button>
          <button type="button" className="button button-quiet" onClick={() => fileInput.current?.click()} disabled={running || importingRepositories}><Icon name="folder" size={15} /> Import URL file</button>
          <input ref={fileInput} className="evaluation-file-input" type="file" accept=".txt,.csv,text/plain,text/csv" onChange={importUrlFile} aria-label="Import a text or CSV file containing GitHub repository URLs" />
        </div>
        <button type="submit" className="button button-primary" disabled={running || importingRepositories}><Icon name={running ? "activity" : "code"} size={15} /> {running ? "Running analyzers…" : "Score repositories"}</button>
      </div>
      {running && <p className="evaluation-run-message" role="status">Fetching each repository and running Documentation, Modularity, Security, and Error handling. This can take a few minutes.</p>}
      {runMessage && !running && <p className="evaluation-run-message" role="status">{runMessage}</p>}
      {runError && <p className="evaluation-run-error" role="alert">{runError}</p>}
      <p className="evaluation-private-note">Public repositories work without credentials. Private repositories need a server-side GitHub token with read access; see the GitHub setup instructions in README.</p>
    </form>

    {!targets.length && <div className="empty-state"><Icon name="code" size={22} /><strong>No analyzer reports are available</strong><p>Add URLs above and run all four analyzers. The resulting JSON scores will be saved to this workspace.</p></div>}
    <div className="evaluation-target-list">
      {targets.map((target) => <section className="evaluation-target-card surface-card" key={`${target.input}-${target.name}`}>
        <header className="evaluation-target-header">
          <div><span className="eyebrow">{target.source === "github" ? "GITHUB REPOSITORY" : "LOCAL WORKSPACE"}</span><h2>{target.name}</h2></div>
          {target.source === "github" && <a className="button" href={target.url} target="_blank" rel="noreferrer">Open repository <Icon name="arrowUpRight" size={14} /></a>}
        </header>
        <p className="evaluation-target-meta">Input: <code>{target.input}</code>{target.generatedAt && <> · Generated {new Date(target.generatedAt).toLocaleString()}</>}</p>
        <div className="evaluation-score-grid">
          {(target.evaluations || []).map((evaluation) => <article className="evaluation-score-card" key={evaluation.id}>
            <div className="evaluation-score-heading"><span>{evaluation.label}</span><Icon name={evaluation.id === "security" ? "lock" : "code"} size={17} /></div>
            <strong className="evaluation-score-value">{number(evaluation.score)}<small>/100</small></strong>
            <span className={`evaluation-status evaluation-status-${evaluation.status}`}>{evaluation.status === "complete" ? evaluation.grade || "Complete" : "Unavailable"}</span>
            <p>{evaluation.summary || evaluation.error || "No summary was provided by the analyzer."}</p>
            {evaluation.breakdown && Object.keys(evaluation.breakdown).length > 0 && <details className="evaluation-breakdown">
              <summary>Score breakdown</summary>
              <dl>{Object.entries(evaluation.breakdown).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{number(typeof value === "object" ? value.score : value)}</dd></div>)}</dl>
            </details>}
          </article>)}
        </div>
      </section>)}
    </div>
    {codeEvaluation?.generatedAt && <p className="evaluation-generated-at">Score bundle generated {new Date(codeEvaluation.generatedAt).toLocaleString()} · {codeEvaluation.urlFile}</p>}
  </>;
}
