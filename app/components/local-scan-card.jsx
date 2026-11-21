import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { EvaluationTarget } from "./evaluation-report";
import { getDesktop, localScanTarget } from "../lib/desktop";

// Only in COVAL for Windows: score a folder on this computer with the bundled engine.
// The code never leaves the computer; nothing is saved to the account.
export default function LocalScanCard() {
  const desktop = getDesktop();
  const [target, setTarget] = useState(null);
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => desktop?.onScanResult((scan) => {
    if (scan) setTarget(localScanTarget(scan));
  }), [desktop]);

  if (!desktop) return null;

  async function scan() {
    setState("running");
    setError("");
    try {
      const result = await desktop.scanFolder();
      if (result) setTarget(localScanTarget(result));
    } catch (scanError) {
      setError(scanError?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || "The scan failed.");
    } finally {
      setState("idle");
    }
  }

  return <>
    <section className="evaluation-import-card surface-card">
      <div className="evaluation-import-heading"><div>
        <span className="eyebrow">ON THIS COMPUTER</span>
        <h2>Score a local folder</h2>
        <p>Runs six agents (Readability, Test coverage, Performance, Maintainability, Scalability, Standards) on this computer. Your code is not uploaded.</p>
      </div></div>
      <div className="evaluation-import-actions">
        <button type="button" className="button button-primary" onClick={scan} disabled={state === "running"}>
          <Icon name="folder" size={15} /> {state === "running" ? "Scoring…" : "Choose a folder"}
        </button>
        {error && <span className="evaluation-run-error" role="alert">{error}</span>}
      </div>
    </section>
    {target && <EvaluationTarget target={target} eyebrow="LOCAL FOLDER" meta={`${target.folder} · ${new Date(target.scannedAt).toLocaleString()}`} />}
  </>;
}
