"""Orchestration: acquire repo -> scan -> analyze (parallel) -> score -> report."""

from __future__ import annotations

import logging
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from functools import partial
from typing import Any, Dict, List, Optional

from .analyzer import analyze_entry
from .repo import RepoWorkspace
from .report import build_report
from .scanner import FileEntry, scan_repository
from .scoring import Aggregate, score_categories

log = logging.getLogger(__name__)


class NoSourceFilesError(Exception):
    """Nothing analyzable in the repository."""


@dataclass
class Options:
    max_files: Optional[int] = None
    max_file_bytes: int = 1_000_000
    clone_timeout: float = 900.0
    branch: Optional[str] = None
    include_tests: bool = False
    jobs: int = 1
    top: int = 5
    progress: bool = True


@dataclass
class RunResult:
    report: Dict[str, Any]
    cleanup_ok: bool
    used_temp_clone: bool
    leftover_path: Optional[str]


class _Progress:
    def __init__(self, total: int, enabled: bool) -> None:
        self.total, self.enabled = total, enabled and total >= 100
        self.n = 0
        self.tty = sys.stderr.isatty()
        self.last = -1

    def update(self) -> None:
        self.n += 1
        if not self.enabled:
            return
        pct = 100 * self.n // self.total
        step = 2 if self.tty else 25
        if pct // step != self.last // step or self.n == self.total:
            self.last = pct
            sys.stderr.write(f"Analyzing: {pct:3d}% ({self.n}/{self.total})" + ("\r" if self.tty else "\n"))
            sys.stderr.flush()

    def close(self) -> None:
        if self.enabled and self.tty:
            sys.stderr.write(" " * 40 + "\r")


def _analyze_all(entries: List[FileEntry], opts: Options):
    prog = _Progress(len(entries), opts.progress)
    out = []
    fn = partial(analyze_entry, max_bytes=opts.max_file_bytes)
    try:
        if opts.jobs > 1 and len(entries) >= 200:
            try:
                with ProcessPoolExecutor(max_workers=opts.jobs) as pool:
                    for r in pool.map(fn, entries, chunksize=16):
                        out.append(r)
                        prog.update()
            except (BrokenProcessPool, OSError) as exc:
                log.warning("parallel analysis failed (%s); continuing serially", exc)
                for e in entries[len(out):]:
                    out.append(fn(e))
                    prog.update()
        else:
            for e in entries:
                out.append(fn(e))
                prog.update()
    finally:
        prog.close()
    return out


def run(spec: str, opts: Options, clone_url_override: Optional[str] = None) -> RunResult:
    started = time.monotonic()
    ws = RepoWorkspace(spec, branch=opts.branch, clone_timeout=opts.clone_timeout,
                       clone_url_override=clone_url_override)
    with ws as info:
        scan = scan_repository(info.root, opts.max_files, opts.max_file_bytes)
        if not scan.entries:
            hint = ""
            if scan.unsupported:
                hint = " Found only unsupported languages: " + ", ".join(
                    f"{k} ({v})" for k, v in scan.unsupported.most_common(4)) + "."
            elif scan.files_seen == 0:
                hint = " The repository appears to be empty."
            raise NoSourceFilesError(
                "no analyzable source files (supported: Python, JavaScript/TypeScript, Java, Go)." + hint)
        log.info("Analyzing %d files ...", len(scan.entries))
        results = _analyze_all(scan.entries, opts)
        usable = [r for r in results if r.skipped is None and r.parse_mode != "failed"
                  and (opts.include_tests or not r.is_test)]
        if not usable:
            raise NoSourceFilesError("no files could be analyzed (all were tests, generated, too large or unparseable)")
        agg = Aggregate.build(usable)
        cats = score_categories(agg)
        report = build_report(info=info, scan=scan, results=results, agg=agg, cats=cats, top=opts.top,
                              duration=time.monotonic() - started, include_tests=opts.include_tests)
    report["cleanup"] = {"temporary_clone_used": ws.used_temp_clone,
                         "temporary_clone_removed": ws.cleanup_ok if ws.used_temp_clone else None}
    report["analysis"]["duration_seconds"] = round(time.monotonic() - started, 2)
    if not ws.cleanup_ok:
        report["warnings"].append(f"FAILED to delete temporary clone at {ws.leftover_path}; remove it manually")
    return RunResult(report, ws.cleanup_ok, ws.used_temp_clone, ws.leftover_path)
