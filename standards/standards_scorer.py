#!/usr/bin/env python3
"""COVAL Standards compliance agent.

Statically scores how closely a repository follows common engineering standards
(0-100): linters, formatters, type checking, project documents (license, contributing,
security policy), consistent file naming, and CI quality gates.

Usage: python standards_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-kit"))
from coval_agent_kit import build_report, fix, ramp, read_text, run_cli, source_files, walk_files  # noqa: E402

VERSION = "1.0.0"
WEIGHTS = {"linting": 0.20, "formatting": 0.15, "type_checking": 0.15, "project_docs": 0.20, "naming_consistency": 0.10, "ci_quality_gates": 0.20}
LABELS = {
    "linting": "Linters configured",
    "formatting": "Formatter configured",
    "type_checking": "Type checking",
    "project_docs": "License, contributing, and security docs",
    "naming_consistency": "Consistent file naming",
    "ci_quality_gates": "CI enforces quality checks",
}
INTERPRETATIONS = {
    "A": "Follows common standards closely.",
    "B": "Mostly standard with a few missing pieces.",
    "C": "Partially standardized; key tooling or docs are missing.",
    "D": "Few standards in place; quality depends on individual habits.",
    "F": "No shared standards are enforced.",
}
LINTERS = {
    "javascript": r"(^|/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|biome\.jsonc?|\.oxlintrc\.json)$",
    "typescript": r"(^|/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|biome\.jsonc?|\.oxlintrc\.json)$",
    "python": r"(^|/)(ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|pylintrc)$",
    "go": r"(^|/)\.golangci\.ya?ml$",
    "ruby": r"(^|/)\.rubocop\.yml$",
}
FORMATTERS = r"(^|/)(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?js|biome\.jsonc?|\.editorconfig|\.rustfmt\.toml|rustfmt\.toml|\.clang-format)$"
DOCS = {"README": 20, "LICENSE": 25, "CONTRIBUTING": 20, "SECURITY": 15, "CODE_OF_CONDUCT": 10, "CHANGELOG": 10}
STYLES = {
    "kebab": re.compile(r"^[a-z0-9]+(-[a-z0-9]+)+$"),
    "snake": re.compile(r"^[a-z0-9]+(_[a-z0-9]+)+$"),
    "camel": re.compile(r"^[a-z]+[a-z0-9]*([A-Z][a-z0-9]*)+$"),
    "pascal": re.compile(r"^([A-Z][a-z0-9]*)+$"),
}


def style_of(stem: str) -> str:
    for name, pattern in STYLES.items():
        if pattern.match(stem):
            return name
    return "single" if re.match(r"^[a-z0-9]+$", stem) else "other"


def analyze_repository(root: Path) -> dict:
    files = source_files(root, include_tests=True)
    if not files:
        raise ValueError("No supported source files were found to evaluate.")
    paths = list(walk_files(root))
    languages = Counter(source.language for source in files)
    package = {}
    try:
        package = json.loads(read_text(root / "package.json") or "{}")
    except ValueError:
        pass
    pyproject = read_text(root / "pyproject.toml")
    setup_cfg = read_text(root / "setup.cfg")
    fixes = []

    def has(pattern: str) -> bool:
        return any(re.search(pattern, path) for path in paths)

    # Linting: share of languages (weighted by file count) covered by a linter config.
    covered = 0
    for language, count in languages.items():
        pattern = LINTERS.get(language)
        configured = bool(pattern and has(pattern))
        if language == "python":
            configured = configured or "[tool.ruff" in pyproject or "[tool.pylint" in pyproject or "[flake8]" in setup_cfg
        if language in {"javascript", "typescript"}:
            configured = configured or "eslintConfig" in package
        if language in {"java", "kotlin", "csharp", "swift", "php", "rust"}:
            configured = configured or has(r"(checkstyle|ktlint|detekt|\.editorconfig|clippy|phpcs|swiftlint)")
        covered += count if configured else 0
        if not configured and pattern:
            fixes.append(fix(f"No linter for {language}", "", f"{count} {language} files are not linted. Add a linter config and run it in CI."))
    lint_score = covered / sum(languages.values()) * 100

    formatter = has(FORMATTERS) or "prettier" in package or "[tool.black" in pyproject or "[tool.ruff.format" in pyproject or set(languages) <= {"go"}
    if not formatter:
        fixes.append(fix("No formatter configured", "", "Add Prettier, Black/Ruff format, or an .editorconfig so style is automatic."))

    typed_share = 0.0
    if languages:
        typed = sum(count for language, count in languages.items() if language in {"typescript", "java", "go", "rust", "csharp", "kotlin", "swift"})
        python_files = [source for source in files if source.language == "python"]
        if python_files:
            annotated = sum(1 for source in python_files if re.search(r"\)\s*->\s*\w|:\s*(str|int|float|bool|list|dict|Path|Optional)\b", source.text))
            typed += annotated * (1.0 if ("[tool.mypy" in pyproject or "[tool.pyright" in pyproject or has(r"(^|/)(mypy\.ini|pyrightconfig\.json)$")) else 0.7)
        js_files = languages.get("javascript", 0)
        if js_files and has(r"(^|/)jsconfig\.json$") and '"checkJs": true' in read_text(root / "jsconfig.json"):
            typed += js_files
        typed_share = typed / sum(languages.values())
    if typed_share < 0.5:
        fixes.append(fix("Little type checking", "", "Add type hints with mypy/pyright, TypeScript, or checkJs so mistakes surface before runtime."))

    doc_score = 0
    for name, points in DOCS.items():
        if any(re.search(rf"(^|/){name}(\.\w+)?$", path, re.I) and path.count("/") <= 1 for path in paths):
            doc_score += points
        elif name in {"LICENSE", "CONTRIBUTING", "SECURITY"}:
            fixes.append(fix(f"Missing {name} file", "", {"LICENSE": "Without a license, others cannot legally reuse the code.", "CONTRIBUTING": "Explain how to set up, test, and submit changes.", "SECURITY": "Tell people how to report vulnerabilities privately."}[name]))

    naming_shares = []
    for language in languages:
        styles = Counter(style_of(Path(source.rel).stem.split(".")[0]) for source in files if source.language == language)
        styles.pop("single", None)
        if sum(styles.values()) >= 4:
            dominant, count = styles.most_common(1)[0]
            naming_shares.append((count / sum(styles.values()), language, dominant))
    naming_score = 100.0 if not naming_shares else min(ramp(share, 0.5, 0.95) for share, _, _ in naming_shares)
    for share, language, dominant in naming_shares:
        if share < 0.9:
            fixes.append(fix(f"Mixed file naming in {language}", "", f"Only {share:.0%} of names use the main {dominant} style."))

    workflows = [path for path in paths if path.startswith(".github/workflows/") or path in {".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml"}]
    ci_text = " ".join(read_text(root / path) for path in workflows)
    ci_score = 0
    if workflows:
        ci_score += 40
        if re.search(r"\b(lint|eslint|ruff|flake8|pylint|golangci|rubocop|biome)\b", ci_text, re.I):
            ci_score += 30
        if re.search(r"\b(test|pytest|jest|vitest|typecheck|tsc|mypy|go test|cargo test)\b", ci_text, re.I):
            ci_score += 30
    if ci_score < 100:
        fixes.append(fix("CI does not enforce lint and tests", workflows[0] if workflows else "", "Run the linter and tests on every pull request and block merges that fail."))

    categories = {
        "linting": {"score": lint_score, "detail": f"{covered} of {sum(languages.values())} source files are covered by a linter config."},
        "formatting": {"score": 100.0 if formatter else 0.0, "detail": "Formatter configured." if formatter else "No formatter configuration found."},
        "type_checking": {"score": ramp(typed_share, 0.0, 0.8), "detail": f"{typed_share:.0%} of source files are statically typed or annotated."},
        "project_docs": {"score": float(doc_score), "detail": "Checks README, LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, and CHANGELOG."},
        "naming_consistency": {"score": naming_score, "detail": ", ".join(f"{language}: {share:.0%} {dominant}" for share, language, dominant in naming_shares) or "Too few files to judge."},
        "ci_quality_gates": {"score": float(ci_score), "detail": f"{len(workflows)} CI workflow files." if workflows else "No CI workflow found."},
    }
    return build_report("standards", VERSION, root, categories, WEIGHTS, LABELS, INTERPRETATIONS, fixes,
                        {"files": len(files), "languages": dict(languages), "ci_workflows": len(workflows)})


if __name__ == "__main__":
    raise SystemExit(run_cli(__doc__, "standards_report.json", "Standards compliance", analyze_repository))
