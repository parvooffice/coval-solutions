"""Command-line interface."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional

from . import __version__
from .models import AnalysisOptions
from .pipeline import NoSourceFilesError, run
from .repo import RepoError
from .report import render_summary, write_json_atomic

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2  # argparse default
EXIT_REPO = 3
EXIT_NO_SOURCES = 4
EXIT_CLEANUP = 5
EXIT_OUTPUT = 6
EXIT_INTERRUPTED = 130

log = logging.getLogger("modularity")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="analyze_modularity.py",
        description="Analyze how modular a public GitHub repository (or local checkout) is "
                    "and write a weighted 0-100 score with a detailed JSON report.",
        epilog="Exit codes: 0 ok, 1 error, 2 usage, 3 repository/clone problem, "
               "4 no analyzable sources, 5 temp-clone cleanup failed, 6 cannot write output, "
               "130 interrupted.",
    )
    p.add_argument("repo", metavar="REPO",
                   help="GitHub URL (https://github.com/owner/repo), owner/repo, or the path "
                        "to an existing local clone (skips cloning, never modified)")
    p.add_argument("-o", "--output", default="modularity_report.json", metavar="FILE",
                   help="output JSON path (default: %(default)s)")
    verbosity = p.add_mutually_exclusive_group()
    verbosity.add_argument("-q", "--quiet", action="store_true",
                           help="only print errors; no progress bar or summary")
    verbosity.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    p.add_argument("--max-files", type=int, metavar="N",
                   help="analyze at most N source files (deterministic sample)")
    p.add_argument("--max-depth", type=int, metavar="N",
                   help="do not descend more than N directory levels below the repo root")
    p.add_argument("--max-file-size", type=int, default=1024, metavar="KB",
                   help="skip files larger than this (default: %(default)s KB)")
    p.add_argument("--file-timeout", type=float, default=10.0, metavar="SEC",
                   help="per-file analysis timeout, 0 disables (default: %(default)s)")
    p.add_argument("--clone-timeout", type=float, default=900.0, metavar="SEC",
                   help="git clone timeout (default: %(default)s)")
    p.add_argument("--branch", metavar="NAME", help="branch or tag to clone (default: remote HEAD)")
    p.add_argument("--include-tests", action="store_true",
                   help="include test files in scoring (excluded by default)")
    p.add_argument("-j", "--jobs", type=int, default=min(4, os.cpu_count() or 1), metavar="N",
                   help="worker processes for large repos (default: %(default)s)")
    p.add_argument("--top", type=int, default=15, metavar="N",
                   help="how many top offenders to list (default: %(default)s)")
    p.add_argument("--no-progress", action="store_true", help="disable the progress indicator")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def _configure_logging(quiet: bool, verbose: bool) -> None:
    level = logging.ERROR if quiet else logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(message)s" if not verbose else
                        "%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    for name in ("max_files", "max_depth", "top", "jobs"):
        value = getattr(args, name)
        if value is not None and value < (0 if name == "max_depth" else 1):
            parser.error(f"--{name.replace('_', '-')} must be a positive integer")
    if args.max_file_size < 1 or args.file_timeout < 0 or args.clone_timeout <= 0:
        parser.error("--max-file-size, --file-timeout and --clone-timeout must be positive")

    _configure_logging(args.quiet, args.verbose)
    opts = AnalysisOptions(
        max_files=args.max_files,
        max_depth=args.max_depth,
        max_file_bytes=args.max_file_size * 1024,
        file_timeout=args.file_timeout,
        clone_timeout=args.clone_timeout,
        branch=args.branch,
        include_tests=args.include_tests,
        jobs=args.jobs,
        top_n=args.top,
        show_progress=not (args.quiet or args.no_progress),
    )

    try:
        result = run(args.repo, opts)
    except KeyboardInterrupt:
        log.error("Interrupted; temporary files were removed.")
        return EXIT_INTERRUPTED
    except RepoError as exc:
        log.error("error: %s", exc)
        return EXIT_REPO
    except NoSourceFilesError as exc:
        log.error("error: %s", exc)
        return EXIT_NO_SOURCES
    except Exception as exc:  # noqa: BLE001
        log.error("error: unexpected failure: %s: %s", type(exc).__name__, exc)
        if args.verbose:
            log.exception("traceback")
        return EXIT_ERROR

    try:
        write_json_atomic(args.output, result.report)
    except OSError as exc:
        log.error("error: cannot write %s: %s", args.output, exc)
        return EXIT_OUTPUT

    if not args.quiet:
        print(render_summary(result.report, os.path.abspath(args.output)))
    if not result.cleanup_ok:
        log.error("error: could not delete temporary clone at %s - please remove it manually",
                  result.leftover_path)
        return EXIT_CLEANUP
    return EXIT_OK
