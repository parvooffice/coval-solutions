"""Shared helpers for COVAL's standard-library code-review agents.

Each agent walks a local checkout (never executing it), scores weighted
categories from 0-100, and writes a report with this shape:

    {"tool", "version", "generated_at", "repository",
     "final_score": {"score", "grade", "interpretation"},
     "summary", "categories": {key: {"label", "score", "weight", "detail"}},
     "fixes": [{"title", "location", "detail"}], "stats": {...}}
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 5_000

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "venv", ".venv", "env", "virtualenv",
    "__pycache__", ".tox", ".nox", ".eggs", "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".idea", ".vscode", "build", "dist", "target", ".gradle", ".next", ".nuxt", "coverage", "vendor",
    "third_party", "third-party", "Pods", ".terraform", "obj", "__pypackages__", "_build", "htmlcov",
    "out", ".output", ".vercel", ".turbo", ".cache",
}
SOURCE_LANGUAGES = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".java": "java", ".go": "go", ".rb": "ruby", ".rs": "rust",
    ".cs": "csharp", ".php": "php", ".kt": "kotlin", ".swift": "swift",
}
GENERATED = re.compile(r"(\.min\.js$|\.bundle\.js$|\.d\.ts$|_pb2(_grpc)?\.py$|\.pb\.go$|\.generated\.|-lock\.|\.lock$)")
TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|specs?|e2e)/|(^test_.*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$)")


@dataclass
class SourceFile:
    rel: str
    language: str
    text: str
    is_test: bool

    @property
    def lines(self) -> list[str]:
        return self.text.splitlines()


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def ramp(value: float, zero_at: float, full_at: float) -> float:
    """Linear 0-100 score; works for ascending (zero_at < full_at) and descending ramps."""
    if zero_at == full_at:
        return 100.0 if value == full_at else 0.0
    return clamp((value - zero_at) / (full_at - zero_at) * 100.0)


def grade(score: float) -> str:
    for threshold, letter in ((85, "A"), (70, "B"), (55, "C"), (40, "D")):
        if score >= threshold:
            return letter
    return "F"


def coval_ignores(root: Path) -> list[str]:
    """Patterns from the `ignore:` list in .coval.yml / .coval.yaml (small YAML subset, no dependency).

    A bare folder such as `legacy/` ignores everything inside it. Same rules as the web app.
    """
    for name in (".coval.yml", ".coval.yaml"):
        path = root / name
        try:
            if not path.is_file() or path.stat().st_size > 64 * 1024:
                continue
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        patterns, in_ignore = [], False
        for raw in lines:
            line = raw.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            if not raw.startswith((" ", "\t", "-")):
                in_ignore = line.strip().rstrip(":") == "ignore"
                continue
            item = line.strip()
            if in_ignore and item.startswith("- "):
                value = item[2:].strip().strip("'\"")
                if value and ".." not in value and not value.startswith("/"):
                    patterns.append(value if "*" in value or "." in Path(value).name else value.rstrip("/") + "/**")
        return patterns[:100]
    return []


def is_ignored(rel: str, patterns: list[str]) -> bool:
    """fnmatch-style matching where `*` also crosses folders, so `legacy/**` covers nested files."""
    return any(fnmatch.fnmatchcase(rel, pattern) or fnmatch.fnmatchcase(f"x/{rel}", pattern) for pattern in patterns)


def walk_files(root: Path) -> Iterator[str]:
    """Yield repository-relative paths, skipping vendored, build, hidden (except .github), and .coval.yml-ignored files."""
    count = 0
    ignores = coval_ignores(root)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        prefix = "" if rel_dir == "." else f"{rel_dir}/"
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and (not d.startswith(".") or d == ".github")
                             and not is_ignored(f"{prefix}{d}/", ignores))
        for name in sorted(filenames):
            count += 1
            if count > MAX_FILES * 4:
                return
            rel = f"{prefix}{name}"
            if not is_ignored(rel, ignores):
                yield rel


def read_text(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def source_files(root: Path, include_tests: bool = False) -> list[SourceFile]:
    files = []
    for rel in walk_files(root):
        language = SOURCE_LANGUAGES.get(os.path.splitext(rel)[1].lower())
        if not language or GENERATED.search(rel):
            continue
        is_test = bool(TEST_PATH.search(rel))
        if is_test and not include_tests:
            continue
        text = read_text(root / rel)
        lines = [line for line in text.splitlines() if line.strip()]
        if not lines or (len(lines) < 4 and max(len(line) for line in lines) > 400):
            continue  # empty or minified
        files.append(SourceFile(rel, language, text, is_test))
        if len(files) >= MAX_FILES:
            break
    return files


def fix(title: str, location: str = "", detail: str = "") -> dict:
    return {key: value for key, value in {"title": title, "location": location, "detail": detail}.items() if value}


def build_report(tool: str, version: str, root: Path, categories: dict, weights: dict, labels: dict,
                 interpretations: dict, fixes: list[dict], stats: dict, extra: dict | None = None) -> dict:
    for key, value in categories.items():
        value["score"] = round(clamp(value["score"]), 1)
        value["label"] = labels[key]
        value["weight"] = weights[key]
    score = round(sum(categories[key]["score"] * weight for key, weight in weights.items()), 1)
    letter = grade(score)
    weakest = min(categories.values(), key=lambda item: item["score"])
    report = {
        "tool": tool,
        "version": version,
        "generated_at": now(),
        "repository": root.name,
        "final_score": {"score": score, "grade": letter, "interpretation": interpretations[letter]},
        "summary": interpretations[letter] + (f" Weakest area: {weakest['label'].lower()} ({weakest['score']:.0f}/100)." if weakest["score"] < 95 else ""),
        "categories": categories,
        "fixes": fixes[:10],
        "stats": stats,
    }
    report.update(extra or {})
    return report


def run_cli(description: str, default_output: str, label: str, analyze: Callable[[Path], dict], argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repo", help="Path to a local checkout (never modified or executed).")
    parser.add_argument("-o", "--output", default=default_output, help="Output JSON path.")
    parser.add_argument("-q", "--quiet", action="store_true", help="Only print errors.")
    args = parser.parse_args(argv)
    root = Path(args.repo).resolve()
    if not root.is_dir():
        print(f"error: Not a directory: {root}", file=sys.stderr)
        return 4
    try:
        report = analyze(root)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 4
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not args.quiet:
        final = report["final_score"]
        print(f"{label}: {final['score']}/100 ({final['grade']}) — {report['summary']}")
    return 0


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1
