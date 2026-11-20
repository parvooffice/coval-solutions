#!/usr/bin/env python3
"""COVAL Maintainability agent.

Statically scores how costly a repository will be to change (0-100): duplicated code,
TODO/FIXME debt, commented-out code, long parameter lists, and dependency hygiene
(lockfiles and pinned versions).

Usage: python maintainability_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-kit"))
from coval_agent_kit import build_report, fix, line_of, ramp, read_text, run_cli, source_files, walk_files  # noqa: E402

VERSION = "1.0.0"
WINDOW = 6
WEIGHTS = {"duplication": 0.30, "todo_debt": 0.15, "commented_code": 0.15, "parameter_lists": 0.15, "dependency_hygiene": 0.25}
LABELS = {
    "duplication": "Little duplicated code",
    "todo_debt": "Low TODO / FIXME debt",
    "commented_code": "No commented-out code",
    "parameter_lists": "Short parameter lists",
    "dependency_hygiene": "Locked, pinned dependencies",
}
INTERPRETATIONS = {
    "A": "Easy to maintain: little duplication or debt, dependencies locked.",
    "B": "Maintainable with some duplication or debt to pay down.",
    "C": "Changes will take extra care: noticeable duplication or debt.",
    "D": "Costly to change: heavy duplication, debt, or loose dependencies.",
    "F": "Very costly to change safely.",
}
TODO = re.compile(r"(#|//|/\*|\*)\s*(TODO|FIXME|HACK|XXX)\b", re.I)
COMMENTED_CODE = re.compile(r"^\s*(//|#)\s*(const|let|var|if\s*\(|for\s*\(|return\b|import\b|function\b|def\s+\w+\(|print\(|console\.\w+\(|\w+\s*=\s*[\w\"'\[{(].*[;)]\s*$)")
PARAMS = re.compile(r"(?:\bdef\s+\w+|\bfunction\s*\w*|\b\w+\s*=\s*(?:async\s*)?)\s*\(([^()]*)\)\s*(?:->[^:]*)?[:{=]")
MANIFESTS = {"package.json": ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"),
             "requirements.txt": (), "pyproject.toml": ("poetry.lock", "uv.lock", "pdm.lock"), "Pipfile": ("Pipfile.lock",),
             "go.mod": ("go.sum",), "Cargo.toml": ("Cargo.lock",), "Gemfile": ("Gemfile.lock",), "composer.json": ("composer.lock",)}


def normalized(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip())


def duplication(files) -> tuple[float, list[dict]]:
    seen: dict[str, list[tuple[str, int]]] = defaultdict(list)
    windows = 0
    for source in files:
        meaningful = [(number, normalized(line)) for number, line in enumerate(source.lines, start=1)
                      if len(line.strip()) > 8 and not line.strip().startswith(("#", "//", "*", "import ", "from ", "}", ")"))]
        for index in range(len(meaningful) - WINDOW + 1):
            chunk = "\n".join(text for _, text in meaningful[index:index + WINDOW])
            seen[hashlib.sha1(chunk.encode()).hexdigest()].append((source.rel, meaningful[index][0]))
            windows += 1
    duplicated = {key: places for key, places in seen.items() if len(places) > 1}
    duplicate_windows = sum(len(places) - 1 for places in duplicated.values())
    fixes, reported = [], set()
    for places in sorted(duplicated.values(), key=len, reverse=True):
        first, second = places[0], places[1]
        pair = (first[0], second[0])
        if pair in reported:
            continue
        reported.add(pair)
        fixes.append(fix("Duplicated block", f"{first[0]}:{first[1]}", f"Also at {second[0]}:{second[1]}. Extract a shared helper."))
        if len(fixes) >= 4:
            break
    return (duplicate_windows / windows if windows else 0.0), fixes


def dependency_hygiene(root: Path, paths: set[str]) -> tuple[float, str, list[dict]]:
    present = [name for name in MANIFESTS if name in paths]
    if not present:
        return 80.0, "No dependency manifest found.", []
    fixes, points = [], []
    for manifest in present:
        locks = MANIFESTS[manifest]
        if manifest == "requirements.txt":
            lines = [line.split("#")[0].strip() for line in read_text(root / manifest).splitlines()]
            requirements = [line for line in lines if line and not line.startswith(("-", "git+"))]
            pinned = [line for line in requirements if "==" in line or "~=" in line]
            share = len(pinned) / len(requirements) if requirements else 1.0
            points.append(40 + 60 * share)
            if share < 1:
                fixes.append(fix("Unpinned Python requirements", manifest, f"{len(requirements) - len(pinned)} of {len(requirements)} use open ranges. Pin with == or add a lock file."))
            continue
        locked = any(lock in paths for lock in locks)
        loose = 0
        if manifest == "package.json":
            try:
                data = json.loads(read_text(root / manifest) or "{}")
                versions = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
                loose = sum(1 for value in versions.values() if str(value).strip() in {"*", "latest", ""})
            except (ValueError, AttributeError):
                pass
        points.append((70 if locked else 20) + (30 if not loose else 0))
        if not locked and locks:
            fixes.append(fix("Missing lock file", manifest, f"Commit {locks[0]} so every install uses the same versions."))
        if loose:
            fixes.append(fix("Wildcard dependency versions", manifest, f"{loose} dependencies use * or latest."))
    return sum(points) / len(points), f"Manifests: {', '.join(present)}.", fixes


def analyze_repository(root: Path) -> dict:
    files = source_files(root)
    if not files:
        raise ValueError("No supported source files were found to evaluate.")
    total_lines = sum(len(source.lines) for source in files)
    per_kloc = 1000 / max(total_lines, 1)
    dup_ratio, dup_fixes = duplication(files)

    todo_fixes, todos, commented, long_params, functions = [], 0, 0, 0, 0
    param_fixes, commented_fixes = [], []
    for source in files:
        for number, line in enumerate(source.lines, start=1):
            if TODO.search(line):
                todos += 1
                if len(todo_fixes) < 3:
                    todo_fixes.append(fix("Unresolved TODO/FIXME", f"{source.rel}:{number}", line.strip()[:120]))
            if COMMENTED_CODE.search(line):
                commented += 1
                if len(commented_fixes) < 2:
                    commented_fixes.append(fix("Commented-out code", f"{source.rel}:{number}", "Delete it; version control keeps the history."))
        for match in PARAMS.finditer(source.text):
            params = [item for item in match.group(1).split(",") if item.strip() and item.strip() not in {"self", "cls", "*"}]
            functions += 1
            if len(params) > 5:
                long_params += 1
                if len(param_fixes) < 3:
                    param_fixes.append(fix(f"Function takes {len(params)} parameters", f"{source.rel}:{line_of(source.text, match.start())}", "Group related values into an object or dataclass."))

    paths = set(walk_files(root))
    dependency_score, dependency_detail, dependency_fixes = dependency_hygiene(root, paths)
    categories = {
        "duplication": {"score": ramp(dup_ratio, 0.15, 0.02), "detail": f"{dup_ratio * 100:.1f}% of {WINDOW}-line blocks appear more than once."},
        "todo_debt": {"score": ramp(todos * per_kloc, 8, 0.5), "detail": f"{todos} TODO/FIXME/HACK markers."},
        "commented_code": {"score": ramp(commented * per_kloc, 10, 0.5), "detail": f"{commented} commented-out code lines."},
        "parameter_lists": {"score": ramp(long_params / max(functions, 1), 0.12, 0.01), "detail": f"{long_params} of {functions} functions take more than five parameters."},
        "dependency_hygiene": {"score": dependency_score, "detail": dependency_detail},
    }
    fixes = dependency_fixes + dup_fixes + param_fixes + commented_fixes + todo_fixes
    return build_report("maintainability", VERSION, root, categories, WEIGHTS, LABELS, INTERPRETATIONS, fixes,
                        {"files": len(files), "lines": total_lines, "todos": todos, "duplicate_ratio": round(dup_ratio, 4)})


if __name__ == "__main__":
    raise SystemExit(run_cli(__doc__, "maintainability_report.json", "Maintainability", analyze_repository))
