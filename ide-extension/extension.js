"use strict";

const path = require("node:path");
const vscode = require("vscode");
const { agentsRoot, scanWorkspace } = require("./lib/agents");

const SCAN_ON_SAVE_INTERVAL_MS = 60_000;

class ScoresProvider {
  constructor() {
    this.scans = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  update(scans) {
    this.scans = scans;
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(parent) {
    if (!parent) {
      if (this.scans.length === 1) return this.agentItems(this.scans[0]);
      return this.scans.map((scan) => {
        const item = new vscode.TreeItem(path.basename(scan.workspace), vscode.TreeItemCollapsibleState.Expanded);
        item.description = scan.overall == null ? "no score" : `overall ${scan.overall}`;
        item.iconPath = new vscode.ThemeIcon("root-folder");
        item.scan = scan;
        return item;
      });
    }
    if (parent.scan) return this.agentItems(parent.scan);
    if (parent.agent) return this.agentDetails(parent.agent, parent.workspace);
    return [];
  }

  agentItems(scan) {
    return [...scan.results].sort((a, b) => (a.score ?? -1) - (b.score ?? -1)).map((agent) => {
      const item = new vscode.TreeItem(agent.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = agent.error ? "failed" : `${agent.score} · ${agent.grade}`;
      item.tooltip = agent.error || agent.summary;
      item.iconPath = new vscode.ThemeIcon(agent.error ? "error" : agent.score >= 70 ? "pass" : agent.score >= 55 ? "warning" : "error",
        new vscode.ThemeColor(agent.error || agent.score < 55 ? "errorForeground" : agent.score < 70 ? "editorWarning.foreground" : "testing.iconPassed"));
      item.agent = agent;
      item.workspace = scan.workspace;
      return item;
    });
  }

  agentDetails(agent, workspace) {
    if (agent.error) {
      const item = new vscode.TreeItem(agent.error);
      item.iconPath = new vscode.ThemeIcon("info");
      return [item];
    }
    const findings = agent.findings.map((finding) => {
      const item = new vscode.TreeItem(finding.title);
      item.description = finding.location || "";
      item.tooltip = new vscode.MarkdownString(`**${finding.title}**\n\n${finding.detail || ""}`);
      item.iconPath = new vscode.ThemeIcon("lightbulb");
      if (finding.position?.file) {
        const uri = vscode.Uri.file(path.join(workspace, finding.position.file));
        const line = Math.max(0, (finding.position.line || 1) - 1);
        item.command = { command: "vscode.open", title: "Open", arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }] };
      }
      return item;
    });
    const categories = agent.categories.map((category) => {
      const item = new vscode.TreeItem(category.label);
      item.description = String(category.score);
      item.tooltip = category.detail;
      item.iconPath = new vscode.ThemeIcon("graph");
      return item;
    });
    return [...findings, ...categories];
  }
}

function activate(context) {
  const root = agentsRoot(context.extensionPath);
  const diagnostics = vscode.languages.createDiagnosticCollection("coval");
  const provider = new ScoresProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const output = vscode.window.createOutputChannel("COVAL");
  status.command = "coval.scanWorkspace";
  status.text = "$(beaker) COVAL";
  status.tooltip = "Score this workspace with COVAL";
  status.show();
  let running = false;
  let lastScan = 0;

  function publish(scans) {
    diagnostics.clear();
    const byFile = new Map();
    for (const scan of scans) {
      for (const agent of scan.results) {
        for (const finding of agent.findings) {
          if (!finding.position?.file) continue;
          const file = path.join(scan.workspace, finding.position.file);
          const line = Math.max(0, (finding.position.line || 1) - 1);
          const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
            `${finding.title}${finding.detail ? ` — ${finding.detail}` : ""}`,
            finding.position.line ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
          diagnostic.source = `COVAL ${agent.label}`;
          if (!byFile.has(file)) byFile.set(file, []);
          byFile.get(file).push(diagnostic);
        }
      }
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
    provider.update(scans);
    const overall = scans.length ? scans[0].overall : null;
    status.text = overall == null ? "$(beaker) COVAL" : `$(beaker) COVAL ${overall}`;
    status.tooltip = scans.map((scan) => `${path.basename(scan.workspace)}: ${scan.overall ?? "no score"} overall`).join("\n") + "\nClick to score again";
  }

  async function scan() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      vscode.window.showInformationMessage("Open a folder to score it with COVAL.");
      return;
    }
    if (running) return;
    running = true;
    lastScan = Date.now();
    const config = vscode.workspace.getConfiguration("coval");
    try {
      const scans = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "COVAL: scoring workspace" },
        () => Promise.all(folders.filter((folder) => folder.uri.scheme === "file").map((folder) => scanWorkspace({
          python: config.get("pythonPath") || "python",
          root,
          workspace: folder.uri.fsPath,
          enabled: config.get("agents") || [],
        }))),
      );
      publish(scans);
      const failures = scans.flatMap((item) => item.results.filter((agent) => agent.error));
      for (const failure of failures) output.appendLine(`[${new Date().toLocaleTimeString()}] ${failure.label}: ${failure.error}`);
      if (failures.length) {
        const choice = await vscode.window.showWarningMessage(`COVAL: ${failures.length} agent(s) could not run. ${failures[0].error}`, "Show details", "Settings");
        if (choice === "Show details") output.show();
        if (choice === "Settings") vscode.commands.executeCommand("workbench.action.openSettings", "coval.pythonPath");
      } else {
        const findings = scans.reduce((sum, item) => sum + item.results.reduce((count, agent) => count + agent.findings.length, 0), 0);
        vscode.window.setStatusBarMessage(`COVAL: overall ${scans[0].overall} · ${findings} findings`, 6000);
      }
    } finally {
      running = false;
    }
  }

  context.subscriptions.push(
    diagnostics, status, output,
    vscode.window.registerTreeDataProvider("coval.scores", provider),
    vscode.commands.registerCommand("coval.scanWorkspace", scan),
    vscode.commands.registerCommand("coval.clearFindings", () => { diagnostics.clear(); provider.update([]); status.text = "$(beaker) COVAL"; }),
    vscode.commands.registerCommand("coval.openWebApp", () => vscode.env.openExternal(vscode.Uri.parse(vscode.workspace.getConfiguration("coval").get("webAppUrl")))),
    vscode.workspace.onDidSaveTextDocument(() => {
      if (vscode.workspace.getConfiguration("coval").get("scanOnSave") && Date.now() - lastScan > SCAN_ON_SAVE_INTERVAL_MS) scan();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
