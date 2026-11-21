"""COVAL engine: runs the six local review agents in one process and prints one JSON result.

Usage:
  coval-engine scan <folder> [--agents readability,performance] [--output result.json]
  coval-engine --version

Packaged with PyInstaller into a single coval-engine.exe that needs no Python install.
The VS Code extension, the coval CLI, and the COVAL desktop app all call it.
"""
from __future__ import annotations

# The agents are loaded from files at run time, so PyInstaller cannot see their imports.
# Import everything they use here so it is packaged.
import argparse
import ast  # noqa: F401
import contextlib
import dataclasses  # noqa: F401
import fnmatch  # noqa: F401
import hashlib  # noqa: F401
import io
import json
import os
import re  # noqa: F401
import runpy
import sys
import tempfile
import typing  # noqa: F401
from collections import Counter, defaultdict  # noqa: F401
from datetime import datetime, timezone  # noqa: F401
from pathlib import Path

VERSION = "0.2.0"

AGENTS = {
    "readability": ("readability", "readability_scorer.py"),
    "test_coverage": ("test-coverage", "test_coverage_scorer.py"),
    "performance": ("performance", "performance_scorer.py"),
    "maintainability": ("maintainability", "maintainability_scorer.py"),
    "scalability": ("scalability", "scalability_scorer.py"),
    "standards": ("standards", "standards_scorer.py"),
}


def agents_root() -> Path:
    """Where the agent folders are: inside the packaged exe, or the repository when developing."""
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled) / "agents"
    return Path(__file__).resolve().parents[1]


def run_agent(agent_id: str, folder: Path) -> dict:
    directory, script = AGENTS[agent_id]
    script_path = agents_root() / directory / script
    handle, output = tempfile.mkstemp(prefix=f"coval-{agent_id}-", suffix=".json")
    os.close(handle)
    saved_argv = sys.argv
    stderr = io.StringIO()
    code = 0
    try:
        sys.argv = [str(script_path), str(folder), "--output", output, "--quiet"]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            try:
                runpy.run_path(str(script_path), run_name="__main__")
            except SystemExit as exit_signal:
                code = exit_signal.code if isinstance(exit_signal.code, int) else (0 if exit_signal.code is None else 1)
        report_text = Path(output).read_text(encoding="utf-8") if Path(output).stat().st_size else ""
        if code == 0 and report_text:
            return {"report": json.loads(report_text)}
        message = stderr.getvalue().strip().splitlines()
        return {"error": message[-1] if message else f"The agent exited with code {code}."}
    except Exception as error:  # one broken agent must not stop the others
        return {"error": f"{type(error).__name__}: {error}"}
    finally:
        sys.argv = saved_argv
        with contextlib.suppress(OSError):
            os.remove(output)


def scan(folder: Path, agent_ids: list[str]) -> dict:
    reports, errors = {}, {}
    for agent_id in agent_ids:
        outcome = run_agent(agent_id, folder)
        if "report" in outcome:
            reports[agent_id] = outcome["report"]
        else:
            errors[agent_id] = outcome["error"]
    return {"engine": VERSION, "folder": str(folder), "reports": reports, "errors": errors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="coval-engine", description="Run COVAL's local review agents.")
    parser.add_argument("--version", action="version", version=f"coval-engine {VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)
    scan_parser = commands.add_parser("scan", help="Score a folder.")
    scan_parser.add_argument("folder")
    scan_parser.add_argument("--agents", default="", help="Comma-separated agent ids (default: all six).")
    scan_parser.add_argument("--output", default="", help="Write the JSON here instead of printing it.")
    args = parser.parse_args(argv)

    folder = Path(args.folder).resolve()
    if not folder.is_dir():
        print(f"error: Not a folder: {folder}", file=sys.stderr)
        return 4
    requested = [item.strip() for item in args.agents.split(",") if item.strip()] or list(AGENTS)
    unknown = [item for item in requested if item not in AGENTS]
    if unknown:
        print(f"error: Unknown agent(s): {', '.join(unknown)}. Choose from {', '.join(AGENTS)}.", file=sys.stderr)
        return 2
    text = json.dumps(scan(folder, requested))
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
