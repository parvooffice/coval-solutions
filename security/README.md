# Autonomous Repository Security Auditor

A terminal-first, production-oriented Python system for auditing a Git repository's security posture.

## Features

- Accepts a repository URL or local path from the CLI
- Creates an isolated temporary workspace and clones the repository
- Detects languages, frameworks, package managers, config files, and CI/CD structure
- Runs a pluggable set of static/security scanners
- Uses a deterministic LangGraph workflow for evidence aggregation and report generation
- Scores repository domains using a weighted security rubric, risk scores, and confidence levels
- Produces a JSON security report in the `reports/` directory with per-finding metadata and category scores
- Secures temporary repository cleanup after analysis
- Exposes a small FastAPI API for programmatic usage

## Quick start

1. Create a virtual environment and install dependencies:

   ```bash
   python -m venv .venv
   . .venv/bin/activate
   python -m pip install -U pip
   python -m pip install -e .
   ```

2. Run the CLI:

   ```bash
   repo-security-auditor
   ```

3. Or pass a repository directly:

   ```bash
   repo-security-auditor https://github.com/example/example-repo.git
   ```

4. Start the API server:

   ```bash
   repo-security-auditor --api --host 0.0.0.0 --port 8000
   ```

The CLI writes JSON reports under the `reports/` directory.
