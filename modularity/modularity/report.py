"""Assemble the JSON report and a short terminal summary."""

from __future__ import annotations

import json
import os
import statistics
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import __version__
from .graph import GraphInfo
from .models import FileMetrics
from .repo import RepoInfo
from .scanner import ScanResult
from .scoring import (
    DIMENSION_LABELS, WEIGHTS, Dimension, rank_problem_files, rank_problem_functions,
)

LIMITATIONS = [
    "Python is analyzed with the standard-library ast module. JavaScript/TypeScript, Java, Go "
    "and C/C++ use comment/string-aware heuristics rather than full parsers, so function "
    "boundaries and complexity are approximate for unusual syntax or heavy macro use.",
    "Import resolution is static: dynamic imports, build-tool aliases, Java same-package "
    "references and C/C++ include-path configuration are not fully modeled, so coupling "
    "tends to be under-reported.",
    "Layer, naming and separation-of-concern checks are directory-name and import-name "
    "heuristics, not architectural proof.",
    "Test files, generated code, vendored/build directories, binaries and files over the "
    "size limit are excluded from scoring.",
    "Scores are relative indicators for comparing repositories and tracking trends, not an "
    "absolute measure of design quality.",
]


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_report(
    *,
    info: RepoInfo,
    scan: ScanResult,
    all_metrics: List[FileMetrics],
    scored: List[FileMetrics],
    graph: GraphInfo,
    dims: Dict[str, Dimension],
    summary: Dict[str, Any],
    top_n: int,
    duration: float,
    extra_warnings: List[str],
    include_tests: bool,
) -> Dict[str, Any]:
    analyzed = [m for m in all_metrics if m.skipped is None]
    skipped = Counter(scan.skipped)
    for m in all_metrics:
        if m.skipped:
            skipped[m.skipped] += 1
    parse_modes = Counter(m.parse_mode for m in analyzed)
    tests = [m for m in analyzed if m.is_test]
    failed = [m for m in analyzed if m.parse_mode == "failed"]

    warnings = list(scan.warnings) + list(extra_warnings)
    if failed:
        warnings.append(
            f"{len(failed)} file(s) could not be parsed and contribute only line counts "
            f"(e.g. {failed[0].path}: {failed[0].error})"
        )
    fallback = parse_modes.get("fallback", 0)
    if fallback:
        warnings.append(f"{fallback} Python file(s) failed ast parsing and were analyzed with a "
                        "regex fallback (Python 2 syntax or templates?)")
    timeouts = skipped.get("timeout", 0)
    if timeouts:
        warnings.append(f"{timeouts} file(s) exceeded the per-file timeout and were skipped")
    if scan.skipped.get("too_large"):
        warnings.append(f"{scan.skipped['too_large']} file(s) over the size limit were skipped")
    for key, dim in dims.items():
        if dim.note:
            warnings.append(f"{DIMENSION_LABELS[key]}: {dim.note}")
        if dim.score is None:
            warnings.append(f"{DIMENSION_LABELS[key]} could not be scored; its weight was "
                            "redistributed across the other dimensions")
    for key, dim in dims.items():
        skipped_parts = [n for n, c in dim.components.items() if c["score"] is None]
        if dim.score is not None and skipped_parts:
            dim.details["components_not_evaluated"] = skipped_parts

    locs = [m.loc for m in scored]
    langs: Dict[str, Dict[str, int]] = defaultdict(lambda: {"files": 0, "loc": 0})
    for m in scored:
        langs[m.language]["files"] += 1
        langs[m.language]["loc"] += m.loc
    all_funcs = [fn for m in scored for fn in m.functions]
    directories = {os.path.dirname(m.path) for m in scored}

    cycles = []
    for comp in graph.sccs[:5]:
        cycles.append({"size": len(comp), "files": comp[:10], "truncated": len(comp) > 10})
    hubs_in = sorted(graph.fan_in.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    hubs_out = sorted(graph.fan_out.items(), key=lambda kv: (-kv[1], kv[0]))[:5]

    dim_out: Dict[str, Any] = {}
    eff = summary.get("effective_weights", {})
    for key, dim in dims.items():
        score = None if dim.score is None else round(100 * dim.score, 1)
        weight = WEIGHTS[key]
        dim_out[key] = {
            "label": DIMENSION_LABELS[key],
            "score": score,
            "weight": weight,
            "effective_weight": round(eff.get(key, 0.0), 4),
            "weighted_contribution": (
                None if score is None else round(score * eff.get(key, 0.0), 2)
            ),
            "components": dim.components,
            "details": dim.details,
        }

    overall = {k: summary[k] for k in ("score", "grade", "interpretation") if k in summary}
    if not overall:
        overall = {"score": None, "grade": None, "interpretation": "Not enough data to score."}

    return {
        "tool": {"name": "modularity-analyzer", "version": __version__},
        "repository": {
            "input": info.input_spec,
            "url": info.url,
            "commit": info.commit,
            "branch": info.branch,
            "source": info.source,
            "analysis_timestamp": _now(),
        },
        "overall": overall,
        "dimensions": dim_out,
        "metrics": {
            "source_files_found": scan.total_candidates,
            "files_analyzed": len(analyzed),
            "files_scored": len(scored),
            "test_files": len(tests),
            "tests_included_in_scoring": include_tests,
            "total_lines": sum(m.total_lines for m in scored),
            "lines_of_code": sum(locs),
            "avg_file_loc": round(statistics.fmean(locs), 1) if locs else 0,
            "median_file_loc": statistics.median(locs) if locs else 0,
            "largest_file_loc": max(locs, default=0),
            "functions": len(all_funcs),
            "classes": sum(m.classes for m in scored),
            "avg_function_lines": (
                round(statistics.fmean(f.lines for f in all_funcs), 1) if all_funcs else 0
            ),
            "modules": len(scored),
            "packages_directories": len(directories),
            "dependency_graph": {
                "nodes": graph.nodes, "edges": graph.edges,
                "max_depth": graph.depth,
                "circular_dependency_groups": len(graph.sccs),
                "files_in_cycles": len(graph.cyclic_nodes),
            },
            "languages": {k: dict(v) for k, v in sorted(langs.items())},
        },
        "top_offenders": {
            "files": rank_problem_files(scored, graph, top_n),
            "functions": rank_problem_functions(scored, top_n),
            "circular_dependencies": cycles,
            "most_depended_on": [{"path": p, "dependents": c} for p, c in hubs_in if c],
            "highest_fan_out": [{"path": p, "dependencies": c} for p, c in hubs_out if c],
        },
        "analysis": {
            "duration_seconds": round(duration, 2),
            "files_skipped": dict(sorted(skipped.items())),
            "parse_modes": dict(parse_modes),
            "ignored_directories": scan.ignored_dirs,
        },
        "warnings": warnings,
        "limitations": LIMITATIONS,
    }


def write_json_atomic(path: str, data: Dict[str, Any]) -> None:
    """Write JSON to *path* via a temp file in the same directory + rename."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".modularity-report-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def render_summary(report: Dict[str, Any], output_path: str) -> str:
    """Compact human-readable summary for the terminal."""
    ov = report["overall"]
    lines = []
    repo = report["repository"]
    title = repo.get("url") or repo["input"]
    lines.append("")
    lines.append(f"Modularity report for {title}")
    if repo.get("commit"):
        lines.append(f"  commit {repo['commit'][:12]}")
    score = "n/a" if ov["score"] is None else f"{ov['score']:.1f}/100 (grade {ov['grade']})"
    lines.append(f"  Overall score: {score}")
    if ov.get("interpretation"):
        lines.append(f"  {ov['interpretation']}")
    lines.append("")
    lines.append("  Dimension                      Score   Weight")
    for d in report["dimensions"].values():
        s = "  n/a" if d["score"] is None else f"{d['score']:5.1f}"
        lines.append(f"  {d['label']:<30} {s}   {d['weight']:.2f}")
    m = report["metrics"]
    lines.append("")
    lines.append(f"  {m['files_scored']} files scored, {m['lines_of_code']:,} LOC, "
                 f"{m['functions']:,} functions, {m['packages_directories']} directories")
    offenders = report["top_offenders"]["files"][:3]
    if offenders:
        lines.append("  Top problem files:")
        for o in offenders:
            lines.append(f"    - {o['path']}: {o['reasons'][0]}")
    if report["warnings"]:
        lines.append(f"  {len(report['warnings'])} warning(s) - see the report")
    lines.append(f"\n  Full report: {output_path}")
    return "\n".join(lines)
