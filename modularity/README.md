# modularity-analyzer

A terminal tool that scores how modular a public GitHub repository is (0–100) and writes a detailed JSON report. No server, no dashboard.

## Install

```bash
pip install -r requirements.txt   # only tqdm (optional progress bar); needs git on PATH
```

Python 3.9+. The analysis itself uses the standard library only.

## Usage

```bash
python analyze_modularity.py https://github.com/owner/repo
python analyze_modularity.py owner/repo -o report.json
python analyze_modularity.py ~/code/my-clone          # local path: no clone, never modified
python analyze_modularity.py owner/repo --max-files 2000 --max-depth 6 --branch main -q
```

| Flag | Meaning |
|---|---|
| `REPO` | GitHub URL, `owner/repo`, or local path |
| `-o, --output FILE` | JSON output (default `modularity_report.json`) |
| `-q / -v` | quiet / verbose |
| `--max-files N`, `--max-depth N` | limits for very large repos (deterministic sample) |
| `--max-file-size KB`, `--file-timeout SEC`, `--clone-timeout SEC` | robustness limits |
| `--branch NAME` | branch or tag to clone |
| `--include-tests` | score test files too (excluded by default) |
| `-j N`, `--top N`, `--no-progress` | workers, offender list size, hide progress |

Exit codes: `0` ok, `1` error, `2` usage, `3` repo/clone problem, `4` no analyzable sources, `5` temp-clone cleanup failed, `6` cannot write output, `130` interrupted.

## Cleanup guarantee

Remote repos are shallow-cloned (`--depth 1`) into a `tempfile.mkdtemp` directory that is removed with `shutil.rmtree` (read-only git files handled, retried) on success, errors, Ctrl+C, SIGTERM/SIGHUP, and via `atexit`. The report records `cleanup.temporary_clone_removed`; if deletion ever fails, the path is printed and the exit code is `5`.

## Scoring

| Dimension | Weight | Looks at |
|---|---|---|
| Coupling | 0.25 | internal fan-out, import cycles (Tarjan SCC), dependency depth, external deps |
| Function cohesion | 0.20 | length, cyclomatic complexity, parameter count |
| File-level | 0.15 | file size, definitions per file, God files |
| Package structure | 0.15 | nesting, flat dumping grounds, layers (domain/application/infrastructure/presentation) and layer-direction violations, intra-package cohesion |
| Code organization | 0.15 | naming consistency, mixed DB/HTTP/web concerns, entry points, package boundaries, tests |
| Encapsulation | 0.10 | private/public ratio, public surface width, interface size |

Dimensions that lack data are dropped and the remaining weights renormalised (reported as `effective_weight`). Grades: A ≥ 85, B ≥ 72, C ≥ 58, D ≥ 45, else F.

Languages: Python (`ast`, regex fallback on syntax errors), JavaScript/TypeScript, Java, Go, C/C++ (comment/string-aware heuristic parsing). Thresholds are scaled for languages that are naturally more verbose (Java, C/C++, Go).

## Report contents

`overall`, `dimensions` (with per-component scores), `metrics`, `top_offenders` (files, functions, cycles, hubs), `repository` (URL, commit, branch, timestamp), `analysis`, `cleanup`, `warnings`, `limitations`.

## Tests

```bash
python -m unittest discover -s tests
```
