# COVAL Code Review for VS Code

Run COVAL's code-review agents on the folder you have open and see the results where you work:

- **Inline findings**: each fix appears as a warning on the exact line and in the Problems panel.
- **Scores panel**: the COVAL icon in the activity bar lists every agent's score (weakest first), its categories, and clickable fixes.
- **Status bar**: your overall score; click it to score again.

Your code stays on your computer. The extension runs six agents locally — Readability, Test coverage, Performance, Maintainability, Scalability, and Standards compliance — using only the Python standard library, and never executes your project's code. For all ten agents (adding Documentation, Modularity, Security, and Error handling), score history, the report assistant, and teams, use **COVAL: Open the full report in COVAL**.

## Requirements

Python 3.10 or newer. If `python` is not on your PATH, set **COVAL › Python Path** (for example `python3` or a full path).

## Commands and settings

| Command | What it does |
|---|---|
| COVAL: Score this workspace | Runs the agents and refreshes findings |
| COVAL: Clear findings | Removes COVAL warnings and scores |
| COVAL: Open the full report in COVAL | Opens the web app |

Settings: `coval.pythonPath`, `coval.agents` (run a subset), `coval.scanOnSave` (re-score after saving, at most once a minute), `coval.webAppUrl`.

## Develop and package

```bash
cd ide-extension
npm test                 # core tests, including a real scan
npm run package          # bundles the agents and builds coval-code-review-0.1.0.vsix
```

To try it without packaging, open `ide-extension/` in VS Code and press **F5**; in development the extension uses the agents from the repository root. Install a built package with **Extensions → … → Install from VSIX**.
