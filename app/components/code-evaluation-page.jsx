import { useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { PageHeading } from "./ui";
import { EvaluationTarget, RunProgress } from "./evaluation-report";
import ReportChat from "./report-chat";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";

const MAX_TARGETS = 5;

function parseUrlText(value) {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean))];
}

function parseUrlFile(value) {
  return [...new Set(value.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).flatMap((line) => line.split(/[\s,;]+/)).map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter((item) => /^https:\/\/github\.com\//i.test(item)))];
}

export default function CodeEvaluationPage() {
  const { codeEvaluation, projects, updateCodeEvaluation } = useDashboardData();
  const [urlText, setUrlText] = useState("");
  const [shareScores, setShareScores] = useState(false);
  const [running, setRunning] = useState(false);
  const [importingRepositories, setImportingRepositories] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runError, setRunError] = useState("");
  const fileInput = useRef(null);
  const targets = [...(codeEvaluation?.targets || [])].sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
  const [runningCount, setRunningCount] = useState(0);
  const importMenu = useRef(null);
  const closeImportMenu = () => importMenu.current?.removeAttribute("open");
  const localWorkspaceAvailable = import.meta.env.DEV;

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
    setRunningCount(urls.length);
    try {
      const result = await apiRequest("/api/code-evaluation", { method: "POST", body: JSON.stringify({ urls, isPublic: shareScores }) });
      updateCodeEvaluation(result.report);
      setUrlText(urls.join("\n"));
      setRunMessage(`Evaluation complete for ${result.report.targets.length} ${result.report.targets.length === 1 ? "repository" : "repositories"}.${shareScores ? " Scores are now shared with signed-in COVAL members." : " Scores are saved privately to your account."}`);
    } catch (error) {
      setRunError(error.message || "The analyzers could not finish this run.");
    } finally {
      setRunning(false);
    }
  }

  async function scoreLocalWorkspace() {
    setRunning(true);
    setRunningCount(1);
    setRunError("");
    setRunMessage("");
    try {
      const result = await apiRequest("/api/code-evaluation", { method: "POST", body: JSON.stringify({ localWorkspace: true }) });
      updateCodeEvaluation(result.report);
      setRunMessage("Local workspace scoring complete. Results are saved to this development checkout.");
    } catch (error) {
      setRunError(error.message || "The local analyzers could not finish this run.");
    } finally {
      setRunning(false);
    }
  }

  const dismissed = new Set(codeEvaluation?.dismissed || []);
  const [shares, setShares] = useState({});
  const [printing, setPrinting] = useState("");

  async function setDismissed(findingKey, restore) {
    const previous = codeEvaluation?.dismissed || [];
    const optimistic = restore ? previous.filter((item) => item !== findingKey) : [...new Set([...previous, findingKey])];
    updateCodeEvaluation({ ...codeEvaluation, dismissed: optimistic });
    try {
      const result = await apiRequest("/api/code-evaluation", { method: "PATCH", body: JSON.stringify({ key: findingKey, restore }) });
      updateCodeEvaluation({ ...codeEvaluation, dismissed: result.dismissed });
    } catch (error) {
      updateCodeEvaluation({ ...codeEvaluation, dismissed: previous });
      setRunError(error.message || "That finding could not be updated.");
    }
  }

  async function shareTarget(target) {
    setShares((current) => ({ ...current, [target.url]: { busy: true } }));
    try {
      const result = await apiRequest("/api/share", { method: "POST", body: JSON.stringify({ targetUrl: target.url }) });
      setShares((current) => ({ ...current, [target.url]: result }));
    } catch (error) {
      setShares((current) => ({ ...current, [target.url]: { error: error.message || "This report could not be shared." } }));
    }
  }

  // Print one repository's report; the browser's print dialog can save it as a PDF.
  function printTarget(key) {
    setPrinting(key);
    document.body.classList.add("printing-report");
    window.setTimeout(() => {
      window.print();
      document.body.classList.remove("printing-report");
      setPrinting("");
    }, 50);
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
      eyebrow="10 CODE-REVIEW AGENTS"
      title="Code evaluation"
      description="Score repositories you can access. Shared results appear in the COVAL community and on your profile."
      action={<button type="button" className="button button-quiet" onClick={downloadScores} disabled={!codeEvaluation?.targets?.length}><Icon name="arrowDown" size={15} /> Download JSON</button>}
    />

    <form className="evaluation-import-card surface-card" onSubmit={runEvaluation}>
      <div className="evaluation-import-heading"><div><span className="eyebrow">GITHUB WORKSPACE / REPOSITORY INPUT</span><h2>Choose projects to score</h2><p>Paste one GitHub repository URL per line, or import a .txt/.csv URL list. Up to {MAX_TARGETS} projects per run.</p></div></div>
      <label className="evaluation-url-label" htmlFor="evaluation-repository-urls">Repository URLs</label>
      <textarea id="evaluation-repository-urls" className="evaluation-url-input" value={urlText} onChange={(event) => setUrlText(event.target.value)} placeholder={"https://github.com/owner/project-one\nhttps://github.com/owner/project-two"} rows={5} spellCheck="false" />
      <div className="evaluation-import-actions">
        <details className="eval-import-menu" ref={importMenu}>
          <summary className="button button-quiet"><Icon name="folder" size={15} /> Import repositories <Icon name="chevronDown" size={14} /></summary>
          <div className="eval-import-menu-list" role="menu">
            <button type="button" role="menuitem" onClick={() => { closeImportMenu(); importMyGitHubRepositories(); }} disabled={importingRepositories || running}><Icon name="git" size={15} /> {importingRepositories ? "Loading GitHub…" : "My public GitHub repos"}</button>
            <button type="button" role="menuitem" onClick={() => { closeImportMenu(); importWorkspaceRepositories(); }} disabled={!projects.length || running}><Icon name="repo" size={15} /> Loaded workspace repos ({projects.length})</button>
            <button type="button" role="menuitem" onClick={() => { closeImportMenu(); fileInput.current?.click(); }} disabled={running || importingRepositories}><Icon name="list" size={15} /> A .txt or .csv URL file</button>
            {localWorkspaceAvailable && <button type="button" role="menuitem" onClick={() => { closeImportMenu(); scoreLocalWorkspace(); }} disabled={running || importingRepositories}><Icon name="code" size={15} /> Score this local workspace (dev)</button>}
          </div>
        </details>
        <input ref={fileInput} className="evaluation-file-input" type="file" accept=".txt,.csv,text/plain,text/csv" onChange={importUrlFile} aria-label="Import a text or CSV file containing GitHub repository URLs" />
        <button type="submit" className="button button-primary eval-submit" disabled={running || importingRepositories}><Icon name={running ? "activity" : "code"} size={15} /> {running ? "Running agents…" : "Score repositories"}</button>
      </div>
      {running && <RunProgress repositories={runningCount || 1} />}
      {runMessage && !running && <p className="evaluation-run-message" role="status">{runMessage}</p>}
      {runError && <p className="evaluation-run-error" role="alert">{runError}</p>}
      <label className="evaluation-share-option"><input type="checkbox" checked={shareScores} onChange={(event) => setShareScores(event.target.checked)} /> <span><strong>Show these scores on my profile</strong><small>Only public repository scores are shared with the COVAL community. Reports stay private unless you check this box.</small></span></label>
      <p className="evaluation-private-note">Any signed-in GitHub user can evaluate public repositories they choose. Private repository access currently requires the workspace owner’s server token; private results cannot be shared.</p>
    </form>

    {!targets.length && <div className="empty-state"><Icon name="code" size={22} /><strong>No analyzer reports are available</strong><p>{localWorkspaceAvailable ? "Score this local workspace or add GitHub URLs to run all ten agents. Results are saved to this development checkout." : "Add GitHub URLs above and run all ten agents to generate scores."}</p></div>}
    {targets.length > 0 && <ReportChat targets={targets} />}
    <div className="evaluation-target-list">
      {targets.map((target) => {
        const key = `${target.input}-${target.name}`;
        const share = shares[target.url];
        return <div key={key} className={printing === key ? "is-printing" : ""}>
          <EvaluationTarget
            target={target}
            eyebrow={target.source === "github" ? "GITHUB REPOSITORY" : "LOCAL WORKSPACE"}
            meta={<>Input: <code>{target.input}</code>{target.generatedAt && <> · Generated {new Date(target.generatedAt).toLocaleString()}</>}</>}
            dismissed={dismissed}
            onDismiss={(findingKey) => setDismissed(findingKey, false)}
            onRestore={(findingKey) => setDismissed(findingKey, true)}
            actions={<div className="eval-target-actions no-print">
              <button type="button" className="button button-quiet" onClick={() => printTarget(key)}><Icon name="arrowDown" size={14} /> PDF</button>
              {target.source === "github" && <button type="button" className="button button-quiet" onClick={() => shareTarget(target)} disabled={share?.busy}><Icon name="link" size={14} /> {share?.busy ? "Sharing…" : "Share"}</button>}
            </div>}
          />
          {share?.error && <p className="evaluation-run-error eval-share-panel" role="alert">{share.error}</p>}
          {share?.shareUrl && <div className="eval-share-panel surface-card no-print">
            <div><strong>Public link</strong><code>{share.shareUrl}</code><button type="button" className="button button-quiet" onClick={() => navigator.clipboard?.writeText(share.shareUrl)}>Copy link</button></div>
            <div><strong>README badge</strong><img src={share.badgeUrl} alt="COVAL score badge" height="20" /><code>{share.markdown}</code><button type="button" className="button button-quiet" onClick={() => navigator.clipboard?.writeText(share.markdown)}>Copy Markdown</button></div>
          </div>}
        </div>;
      })}
    </div>
    <section className="evaluation-community-section">
      <div className="evaluation-community-heading"><div><span className="eyebrow">COMMUNITY / SHARED RESULTS</span><h2>Scores from COVAL members</h2><p>Public repository evaluations shared by signed-in members.</p></div></div>
      {!codeEvaluation?.publicEvaluations?.length && <div className="empty-state"><Icon name="users" size={22} /><strong>No shared evaluations yet</strong><p>When a member opts to share a score for a public repository, it will appear here.</p></div>}
      <div className="evaluation-target-list">
        {(codeEvaluation?.publicEvaluations || []).map((bundle, bundleIndex) => (bundle.targets || []).map((target) => <EvaluationTarget
          key={`${bundle.githubLogin}-${target.url}-${bundleIndex}`}
          target={target}
          showFixes={false}
          eyebrow={`SHARED BY @${bundle.githubLogin || "COVAL MEMBER"}`}
          meta={`Evaluated ${target.generatedAt ? new Date(target.generatedAt).toLocaleString() : bundle.sharedAt ? new Date(bundle.sharedAt).toLocaleString() : "recently"}`}
        />))}
      </div>
    </section>
    {codeEvaluation?.generatedAt && <p className="evaluation-generated-at">Score bundle generated {new Date(codeEvaluation.generatedAt).toLocaleString()} · {codeEvaluation.urlFile}</p>}
  </>;
}
