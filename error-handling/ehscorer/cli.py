"""Command-line interface."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional

from . import __version__
from .pipeline import NoSourceFilesError, Options, run
from .repo import RepoError
from .report import render_summary, write_json_atomic
from .scoring import WEIGHTS, LABELS

EXIT_OK, EXIT_ERROR, EXIT_REPO, EXIT_NO_SOURCES, EXIT_CLEANUP, EXIT_OUTPUT, EXIT_INT = 0, 1, 3, 4, 5, 6, 130
log = logging.getLogger("ehscorer")


def build_parser() -> argparse.ArgumentParser:
    weights = "\n".join(f"  {int(w * 100):>3}%  {LABELS[k]}" for k, w in WEIGHTS.items())
    p = argparse.ArgumentParser(
        prog="error_handling_scorer.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Score the error-handling quality of a public GitHub repository (0-100) and write "
                    "a JSON report. The repository is shallow-cloned into a temp directory that is "
                    "always deleted afterwards.",
        epilog=f"scoring weights:\n{weights}\n\nexit codes: 0 ok, 1 error, 2 usage, 3 repository/clone "
               "problem, 4 nothing to analyze, 5 temp cleanup failed, 6 cannot write output, 130 interrupted.\n\n"
               "examples:\n  python error_handling_scorer.py https://github.com/pallets/flask\n"
               "  python error_handling_scorer.py psf/requests -o results.json\n"
               "  python error_handling_scorer.py ./my-local-clone -q",
    )
    p.add_argument("repo", metavar="REPO", help="GitHub URL, owner/repo, or path to a local clone (never modified)")
    p.add_argument("-o", "--output", default="error_handling_report.json", metavar="FILE",
                   help="output JSON path (default: %(default)s)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("-q", "--quiet", action="store_true", help="errors only; no progress or summary")
    g.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    p.add_argument("--branch", metavar="NAME", help="branch or tag to clone (default: remote HEAD)")
    p.add_argument("--include-tests", action="store_true", help="also score test files (excluded by default)")
    p.add_argument("--max-files", type=int, metavar="N", help="analyze at most N files (deterministic sample)")
    p.add_argument("--max-file-size", type=int, default=1024, metavar="KB",
                   help="skip files larger than this (default: %(default)s KB)")
    p.add_argument("--clone-timeout", type=float, default=900.0, metavar="SEC",
                   help="git clone timeout (default: %(default)s)")
    p.add_argument("-j", "--jobs", type=int, default=min(4, os.cpu_count() or 1), metavar="N",
                   help="worker processes for large repos (default: %(default)s)")
    p.add_argument("--top", type=int, default=5, metavar="N",
                   help="examples listed per issue type (default: %(default)s)")
    p.add_argument("--no-progress", action="store_true", help="disable the progress indicator")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.max_files is not None and args.max_files < 1:
        parser.error("--max-files must be positive")
    if args.max_file_size < 1 or args.clone_timeout <= 0 or args.jobs < 1 or args.top < 1:
        parser.error("--max-file-size, --clone-timeout, --jobs and --top must be positive")
    level = logging.ERROR if args.quiet else logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format="%(message)s", stream=sys.stderr)
    opts = Options(max_files=args.max_files, max_file_bytes=args.max_file_size * 1024,
                   clone_timeout=args.clone_timeout, branch=args.branch, include_tests=args.include_tests,
                   jobs=args.jobs, top=args.top, progress=not (args.quiet or args.no_progress))
    try:
        result = run(args.repo, opts)
    except KeyboardInterrupt:
        log.error("Interrupted; temporary files were removed.")
        return EXIT_INT
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
        log.error("error: could not delete temporary clone at %s - please remove it manually", result.leftover_path)
        return EXIT_CLEANUP
    return EXIT_OK
