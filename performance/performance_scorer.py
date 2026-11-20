#!/usr/bin/env python3
"""COVAL Performance agent.

Statically scores performance risks (0-100) without running the code: I/O or awaits
inside loops, blocking calls in request paths, deeply nested loops, costly patterns
(deep clones, unbounded SELECT *, regex compiled in loops), and heavy assets.

Usage: python performance_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-kit"))
from coval_agent_kit import build_report, fix, ramp, run_cli, source_files, walk_files  # noqa: E402

VERSION = "1.0.0"
WEIGHTS = {"io_in_loops": 0.30, "blocking_calls": 0.20, "nested_loops": 0.15, "costly_patterns": 0.15, "asset_weight": 0.20}
LABELS = {
    "io_in_loops": "No network, database, or file I/O inside loops",
    "blocking_calls": "No blocking calls in request paths",
    "nested_loops": "Shallow loop nesting",
    "costly_patterns": "No costly patterns",
    "asset_weight": "Lightweight assets",
}
INTERPRETATIONS = {
    "A": "Efficient: no significant performance risks found.",
    "B": "Mostly efficient with a few hotspots worth fixing.",
    "C": "Several patterns that slow down under load.",
    "D": "Frequent performance risks such as sequential I/O in loops.",
    "F": "Widespread performance risks that will hurt users at scale.",
}
LOOP = re.compile(r"^\s*(async\s+)?(for|while)\b.*:\s*$|^\s*(for|while)\s*\(|\.forEach\(\s*async\b")
IO_CALL = re.compile(
    r"\bawait\s|\bfetch\(|\brequests\.(get|post|put|patch|delete)\(|\burlopen\(|\.query\(|\.execute\(|"
    r"\bsupabaseRest\(|\breadFile(Sync)?\(|\bwriteFile(Sync)?\(|\bopen\("
)
BLOCKING = re.compile(r"\b(readFileSync|writeFileSync|execSync|spawnSync|execFileSync|existsSync|readdirSync)\(|\btime\.sleep\(")
COSTLY = [
    (re.compile(r"JSON\.parse\(\s*JSON\.stringify\("), "Deep clone via JSON round-trip", "Use structuredClone() or copy only the fields you need."),
    (re.compile(r"select\s+\*\s+from|[?&]select=\*", re.I), "Unbounded SELECT *", "Select only the columns you use."),
]
LOOP_ONLY = [
    (re.compile(r"\bre\.compile\(|new RegExp\("), "Regex compiled inside a loop", "Compile the pattern once outside the loop."),
]
BINARY_ASSETS = re.compile(r"\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|woff2?|ttf|otf)$", re.I)
SCRIPT_PATHS = re.compile(r"(^|/)(scripts?|bin|tools|migrations)/|\.config\.[cm]?[jt]s$")


def indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def loop_depths(lines: list[str]) -> list[int]:
    """Loop nesting depth for every line, using indentation to find loop bodies."""
    depths = []
    stack: list[int] = []
    for line in lines:
        if not line.strip():
            depths.append(len(stack))
            continue
        level = indent(line)
        while stack and level <= stack[-1]:
            stack.pop()
        depths.append(len(stack))
        if LOOP.search(line):
            stack.append(level)
    return depths


def analyze_repository(root: Path) -> dict:
    files = source_files(root)
    if not files:
        raise ValueError("No supported source files were found to evaluate.")
    findings: list[tuple[int, dict]] = []
    io_hits = blocking_files = nested_hits = costly_hits = 0
    total_lines = 0
    for source in files:
        lines = source.lines
        total_lines += len(lines)
        depths = loop_depths(lines)
        file_blocking = False
        reported_nested = False
        for number, (line, depth) in enumerate(zip(lines, depths), start=1):
            stripped = line.strip()
            if stripped.startswith(("#", "//", "*")):
                continue
            if depth and IO_CALL.search(line) and "Promise.all" not in line:
                io_hits += 1
                findings.append((3, fix("I/O inside a loop runs one request at a time", f"{source.rel}:{number}", "Batch the work or run it concurrently (Promise.all / asyncio.gather) with a limit.")))
            if depth >= 3 and not reported_nested:
                nested_hits += 1
                reported_nested = True
                findings.append((2, fix("Three or more nested loops", f"{source.rel}:{number}", "Use a lookup map or set to avoid quadratic or cubic work.")))
            if BLOCKING.search(line) and not SCRIPT_PATHS.search(source.rel):
                file_blocking = True
                findings.append((2, fix("Blocking call in application code", f"{source.rel}:{number}", "Use the async version so one request does not stall the others.")))
            for pattern, title, detail in COSTLY + (LOOP_ONLY if depth else []):
                if pattern.search(line):
                    costly_hits += 1
                    findings.append((1, fix(title, f"{source.rel}:{number}", detail)))
        blocking_files += file_blocking

    heavy_assets = []
    for rel in walk_files(root):
        if BINARY_ASSETS.search(rel):
            try:
                size = (root / rel).stat().st_size
            except OSError:
                continue
            if size > 300 * 1024:
                heavy_assets.append((rel, size))
    heavy_assets.sort(key=lambda item: item[1], reverse=True)
    for rel, size in heavy_assets[:3]:
        findings.append((1, fix("Large asset", rel, f"{size / 1024:.0f} KB. Compress it or serve a smaller format (WebP/AVIF, subset fonts).")))

    per_kloc = 1000 / max(total_lines, 1)
    categories = {
        "io_in_loops": {"score": ramp(io_hits * per_kloc, 3.0, 0.2), "detail": f"{io_hits} I/O calls or awaits inside loops."},
        "blocking_calls": {"score": ramp(blocking_files / len(files), 0.15, 0.0), "detail": f"{blocking_files} application files use blocking calls."},
        "nested_loops": {"score": ramp(nested_hits / len(files), 0.15, 0.0), "detail": f"{nested_hits} files nest loops three or more levels deep."},
        "costly_patterns": {"score": ramp(costly_hits * per_kloc, 2.0, 0.0), "detail": f"{costly_hits} costly patterns (deep clones, SELECT *, regex in loops)."},
        "asset_weight": {"score": ramp(len(heavy_assets), 8, 0), "detail": f"{len(heavy_assets)} assets larger than 300 KB."},
    }
    findings.sort(key=lambda item: -item[0])
    return build_report("performance", VERSION, root, categories, WEIGHTS, LABELS, INTERPRETATIONS,
                        [item for _, item in findings], {"files": len(files), "lines": total_lines})


if __name__ == "__main__":
    raise SystemExit(run_cli(__doc__, "performance_report.json", "Performance", analyze_repository))
