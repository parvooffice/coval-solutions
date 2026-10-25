"""End-to-end orchestration: acquire repo -> scan -> analyze -> score -> report."""

from __future__ import annotations

import logging
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from functools import partial
from typing import Any, Callable, Dict, Iterable, List, Optional

from .analyzers import AnalysisLimits, analyze_entry
from .graph import build_graph
from .models import AnalysisOptions, FileEntry, FileMetrics
from .repo import RepoWorkspace
from .report import build_report
from .scanner import scan_repository
from .scoring import compute_scores

log = logging.getLogger(__name__)


class NoSourceFilesError(Exception):
    """The repository contains nothing we know how to analyze."""


@dataclass
class RunResult:
    report: Dict[str, Any]
    cleanup_ok: bool
    used_temp_clone: bool
    leftover_path: Optional[str]


class Progress:
    """Minimal progress reporter: tqdm if installed, else a one-line counter."""

    def __init__(self, total: int, enabled: bool, label: str) -> None:
        self.total = total
        self.enabled = enabled and total > 0
        self.label = label
        self._bar = None
        self._count = 0
        self._last_pct = -1
        self._tty = sys.stderr.isatty()
        if not self.enabled:
            return
        try:
            from tqdm import tqdm  # type: ignore

            self._bar = tqdm(total=total, desc=label, unit="file", file=sys.stderr,
                             leave=False, dynamic_ncols=True)
        except ImportError:
            self._bar = None

    def update(self, n: int = 1) -> None:
        self._count += n
        if not self.enabled:
            return
        if self._bar is not None:
            self._bar.update(n)
            return
        pct = int(100 * self._count / self.total)
        step = 1 if self._tty else 25
        if pct // step != self._last_pct // step or self._count == self.total:
            self._last_pct = pct
            end = "\r" if self._tty else "\n"
            sys.stderr.write(f"{self.label}: {pct:3d}% ({self._count}/{self.total}){end}")
            sys.stderr.flush()

    def close(self) -> None:
        if not self.enabled:
            return
        if self._bar is not None:
            self._bar.close()
        elif self._tty:
            sys.stderr.write(" " * 60 + "\r")
            sys.stderr.flush()


def analyze_files(entries: List[FileEntry], opts: AnalysisOptions) -> List[FileMetrics]:
    """Analyze every entry, in parallel for larger repositories."""
    limits = AnalysisLimits(opts.max_file_bytes, opts.file_timeout)
    progress = Progress(len(entries), opts.show_progress, "Analyzing")
    results: List[FileMetrics] = []
    try:
        jobs = max(1, opts.jobs)
        if jobs > 1 and len(entries) >= 150:
            try:
                with ProcessPoolExecutor(max_workers=jobs) as pool:
                    for fm in pool.map(partial(analyze_entry, limits=limits), entries, chunksize=16):
                        results.append(fm)
                        progress.update()
            except (BrokenProcessPool, OSError) as exc:
                log.warning("parallel analysis failed (%s); continuing serially", exc)
                for entry in entries[len(results):]:
                    results.append(analyze_entry(entry, limits))
                    progress.update()
        else:
            for entry in entries:
                results.append(analyze_entry(entry, limits))
                progress.update()
    finally:
        progress.close()
    return results


def run(spec: str, opts: AnalysisOptions, clone_url_override: Optional[str] = None) -> RunResult:
    """Analyze *spec* (GitHub URL, owner/repo or local path) and return the report."""
    started = time.monotonic()
    workspace = RepoWorkspace(
        spec, branch=opts.branch, clone_timeout=opts.clone_timeout,
        clone_url_override=clone_url_override,
    )
    report: Dict[str, Any]
    with workspace as info:
        log.info("Scanning %s ...", "clone" if info.source == "clone" else info.root)
        scan = scan_repository(info.root, opts)
        if not scan.entries:
            raise NoSourceFilesError(
                "no analyzable source files found (supported: Python, JavaScript/TypeScript, "
                "Java, Go, C/C++)"
            )
        log.info("Found %d source files (%d candidate, %d dirs ignored)",
                 len(scan.entries), scan.total_candidates, scan.ignored_dirs)

        all_metrics = analyze_files(scan.entries, opts)
        analyzed = [m for m in all_metrics if m.skipped is None]
        scored = [m for m in analyzed if m.parse_mode != "failed" and m.loc > 0
                  and (opts.include_tests or not m.is_test)]
        if not scored:
            raise NoSourceFilesError(
                "no files could be scored (everything was test code, generated, too large "
                "or unparseable)"
            )

        log.info("Building dependency graph and scoring ...")
        graph = build_graph(analyzed, scored, scan.go_modules)
        dims, summary = compute_scores(scored, analyzed, graph)
        report = build_report(
            info=info, scan=scan, all_metrics=all_metrics, scored=scored, graph=graph,
            dims=dims, summary=summary, top_n=opts.top_n,
            duration=time.monotonic() - started, extra_warnings=[],
            include_tests=opts.include_tests,
        )

    # The workspace has now removed any temporary clone; record the outcome.
    report["cleanup"] = {
        "temporary_clone_used": workspace.used_temp_clone,
        "temporary_clone_removed": (workspace.cleanup_ok if workspace.used_temp_clone else None),
    }
    report["analysis"]["duration_seconds"] = round(time.monotonic() - started, 2)
    if not workspace.cleanup_ok:
        report["warnings"].append(
            f"FAILED to delete temporary clone at {workspace.leftover_path}; remove it manually"
        )
    return RunResult(report, workspace.cleanup_ok, workspace.used_temp_clone, workspace.leftover_path)
