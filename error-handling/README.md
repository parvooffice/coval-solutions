# error-handling-scorer

A terminal tool that scores the **error-handling quality** of a public GitHub repository (0–100) and writes a JSON report with a category breakdown, a plain-English summary, highlights (good practices) and issues (anti-patterns with file:line examples). Standard library only; no GUI, no server.

## Quick start

```bash
python error_handling_scorer.py https://github.com/owner/repo
python error_handling_scorer.py https://github.com/owner/repo -o results.json
python error_handling_scorer.py owner/repo --branch main -q
python error_handling_scorer.py ./already-cloned-repo      # skips cloning, never modified
```

Requires Python 3.9+ and `git` on your PATH. `requirements.txt` has no packages to install.

## How it works

1. **Shallow clone** (`--depth 1 --single-branch`, no tags, LFS skipped, no credential prompts) into a `tempfile.mkdtemp` directory. The directory is deleted on success, on errors, on Ctrl+C / SIGTERM, and via `atexit`. The report records `cleanup.temporary_clone_removed`; exit code 5 is returned if deletion ever fails.
2. **Fast walk**: skips `.git`, `node_modules`, virtualenvs, build/dist/vendor dirs, symlinks, binaries, minified/generated code and files over 1 MB. Test, example and doc directories are excluded by default (`--include-tests` to change).
3. **Analysis** (parallel for large repos): Python is parsed with `ast`; JavaScript/TypeScript, Java and Go use comment- and string-aware pattern matching (so their numbers are estimates).
4. **Scoring**: seven weighted categories, each 0–100. A category without enough evidence is dropped and the remaining weights are renormalised (shown as `effective_weight`).

## Scoring weights

| Weight | Category | What earns points |
|---|---|---|
| 17% | Exception specificity | Catching specific types. Bare `except:` = 0, `except Exception` = 0.25 (0.6 if it logs/re-raises), specific = 1.0 |
| 18% | Handler quality | Handlers that log or re-raise (1.0), print/use the error (0.7), do something else (0.4–0.6); silent `pass`/empty catch scores 0–0.25. Idiomatic ignores (e.g. optional `ImportError`) are exempt |
| 12% | Propagation vs. swallowing | Few silent swallows (45%), re-raises that keep the cause — `raise … from e`, `%w`, `cause` (30%), no bare `Exception`/`RuntimeException` raised (25%) |
| 8% | Custom exceptions | Count relative to size, shared base class, actually raised/caught. Not scored for small code bases without any |
| 15% | Input validation | Non-trivial public functions with guard clauses that raise or validating decorators (60%); defensive checks overall — `isinstance`, `None` checks, `assert`, defaults (40%) |
| 15% | Resource cleanup | Files/sockets/connections via `with` / try-with-resources / `defer` vs. manual close vs. never closed (70%); how often with/finally/context managers are used (30%) |
| 15% | Critical-path coverage | Share of risky operations (file I/O, network, parsing, subprocess, DB) inside try / `with` / a Java method declaring `throws` (80%); network calls that set a timeout (20%) |

Grades: **A** ≥ 85, **B** ≥ 72, **C** ≥ 58, **D** ≥ 45, otherwise **F**.

A headline score needs at least **3 scored categories**. Otherwise `final_score.score` is `null` with an explanation (typical for libraries that pass errors to callers by design). Every score also carries a `confidence` (`high` / `medium` / `low`).

## Report contents

```
final_score   score, grade, interpretation, confidence
summary       how the score was derived, strongest / weakest area
categories    per category: score, weight, effective_weight, weighted_contribution, criteria, evidence
highlights    good practices found
issues        anti-patterns with severity, count and file:line examples
metrics       files, LOC, handlers, languages, ...
repository    URL, commit, branch, timestamp
warnings / limitations / cleanup / analysis
```

## Options

| Flag | Meaning |
|---|---|
| `-o, --output FILE` | output path (default `error_handling_report.json`) |
| `-q / -v` | quiet / verbose |
| `--branch NAME` | branch or tag to clone |
| `--include-tests` | also score test files |
| `--max-files N` | deterministic sample for huge repos |
| `--max-file-size KB` | skip larger files (default 1024) |
| `--clone-timeout SEC` | default 900 |
| `-j N` | worker processes (default ≤ 4) |
| `--top N` | examples per issue type (default 5) |
| `--no-progress` | hide the progress indicator |

Exit codes: `0` ok · `1` error · `2` usage · `3` repository/clone problem (not found, private, no network, bad URL) · `4` nothing to analyze (empty repo or unsupported languages) · `5` temp cleanup failed · `6` cannot write output · `130` interrupted.

## Limitations

- Analysis is lexical and per file: a risky call whose *caller* handles the error is counted as unprotected, so libraries that deliberately propagate can be under-scored.
- JS/TS, Java and Go analysis is heuristic. Go errors are modelled as `if err != nil` handlers plus ignored (`_`) error returns.
- Only common standard-library and popular-package calls are recognised as risky operations or resources.
- Supported languages: Python, JavaScript/TypeScript, Java, Go. Other languages are listed in `warnings` and ignored.
- The score reflects observable practices, not correctness. Use it to compare repositories and track trends.

## Tests

```bash
python -m unittest discover -s tests
```
