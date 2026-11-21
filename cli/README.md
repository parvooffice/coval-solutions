# COVAL CLI

Score a repository and review pull requests from your terminal or CI. The CLI uses the same agents and the same review format as the COVAL VS Code extension and the COVAL GitHub App, so a pull request gets the same verdict everywhere.

## Install

Requires Node.js 20+ and Python 3.10+.

Download `coval-cli-<version>.tgz` from the [latest GitHub release](https://github.com/parvooffice/coval-solutions/releases/latest), then:

```bash
npm install -g ./coval-cli-0.1.0.tgz
coval --help
```

## Commands

```bash
coval scan                      # score the current folder
coval scan ../other-project --json

coval review                    # compare your working tree with main
coval review --base develop --head feature/login
coval review --fail-under 70 --fail-on-drop 2   # exit code 2 blocks a merge in CI
```

`coval review` checks out the base ref in a temporary Git worktree, scores both versions, and prints each agent's score change and the findings your branch introduced.

## In GitHub Actions

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- uses: actions/setup-python@v5
  with: { python-version: "3.12" }
- run: npm install -g https://github.com/parvooffice/coval-solutions/releases/download/v0.1.0/coval-cli-0.1.0.tgz
- run: git fetch origin ${{ github.base_ref }}
- run: coval review --comment --fail-on-drop 5
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--comment` posts (or updates) one COVAL comment on the pull request. Paths listed under `ignore:` in the repository's `.coval.yml` are skipped.

The CLI runs six agents locally: Readability, Test coverage, Performance, Maintainability, Scalability, and Standards compliance. The COVAL web app adds Documentation, Modularity, Security, and Error handling, plus AI fix explanations.
