"""Assemble the JSON report and the terminal summary."""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List

from . import __version__
from .metrics import FileResult
from .repo import RepoInfo
from .scanner import ScanResult
from .scoring import (CRITERIA, LABELS, WEIGHTS, Aggregate, CategoryResult, build_highlights,
                      build_issues, confidence, grade, overall)

MIN_CATEGORIES = 3

LIMITATIONS = [
    "Python is analyzed with the ast module; JavaScript/TypeScript, Java and Go use comment- and "
    "string-aware pattern matching, so their numbers are approximations.",
    "Analysis is lexical and per-file: errors handled by a caller in another function or file are "
    "not credited to the callee, so libraries that deliberately propagate may be under-scored on "
    "critical-path coverage.",
    "Only well-known standard-library and popular-package calls are recognised as risky operations "
    "or resources; wrappers around them are not.",
    "Test files, examples, vendored/generated code and files over the size limit are excluded.",
    "The score measures observable error-handling practices, not whether the code behaves correctly.",
]


def _summary(score: float, g: str, cats: Dict[str, CategoryResult], eff: Dict[str, float],
             agg: Aggregate, languages: List[str], note_missing: List[str]) -> str:
    scored = {k: r for k, r in cats.items() if r.score is not None}
    best = max(scored, key=lambda k: scored[k].score)
    worst = min(scored, key=lambda k: scored[k].score)
    parts = [
        f"Analyzed {agg.files} source files ({agg.loc:,} lines of {', '.join(languages)}) and scored "
        f"{len(scored)} categories from 0 to 100. The final score of {score:.1f} (grade {g}) is the weighted "
        f"average of those category scores using the weights listed under `categories`.",
        f"Strongest area: {LABELS[best]} ({100 * scored[best].score:.0f}). "
        f"Weakest area: {LABELS[worst]} ({100 * scored[worst].score:.0f}).",
    ]
    if note_missing:
        parts.append("Not scored (insufficient evidence, weight redistributed): " + "; ".join(note_missing) + ".")
    return " ".join(parts)


def build_report(*, info: RepoInfo, scan: ScanResult, results: List[FileResult], agg: Aggregate,
                 cats: Dict[str, CategoryResult], top: int, duration: float,
                 include_tests: bool) -> Dict[str, Any]:
    score, eff = overall(cats)
    n_scored = sum(1 for r in cats.values() if r.score is not None)
    if n_scored < MIN_CATEGORIES:
        score = None  # a headline number built from 1-2 categories would be misleading
    skipped = Counter(scan.skipped)
    for r in results:
        if r.skipped:
            skipped[r.skipped] += 1
    failed = [r for r in results if r.parse_mode == "failed"]
    warnings: List[str] = []
    if scan.truncated:
        warnings.append(f"--max-files reached: analyzed a deterministic sample of {len(scan.entries)} of "
                        f"{scan.candidates} files")
    if failed:
        warnings.append(f"{len(failed)} file(s) could not be parsed and were ignored "
                        f"(e.g. {failed[0].path}: {failed[0].error})")
    if scan.unsupported:
        warnings.append("Unsupported languages present and ignored: " + ", ".join(
            f"{k} ({v} files)" for k, v in scan.unsupported.most_common(5)))
    langs = sorted(agg.languages)
    if any(l != "python" for l in langs):
        warnings.append("Non-Python languages use heuristic (regex-based) analysis; treat their scores as estimates")
    for k, r in cats.items():
        if r.note:
            warnings.append(f"{LABELS[k]}: {r.note}")

    cat_out: Dict[str, Any] = {}
    missing = []
    for k, r in cats.items():
        s = None if r.score is None else round(100 * r.score, 1)
        if s is None:
            missing.append(LABELS[k])
        cat_out[k] = {
            "label": LABELS[k], "score": s, "weight": WEIGHTS[k],
            "effective_weight": round(eff[k], 4),
            "weighted_contribution": None if s is None else round(s * eff[k], 2),
            "criteria": CRITERIA[k], "evidence": r.evidence,
            "note": r.note,
        }
    if score is None:
        final = {"score": None, "grade": None, "confidence": "none",
                 "interpretation": f"Not enough evidence to produce a score: only {n_scored} of {len(cats)} "
                                   f"categories could be evaluated (minimum {MIN_CATEGORIES}).",
                 "confidence_reason": "the repository has very few error handlers, risky operations or resources"}
        summary = (f"Analyzed {agg.files} source files ({agg.loc:,} lines) but found too little "
                   "error-handling-relevant code (try/catch handlers, I/O, network or parsing calls, resources) "
                   "to score reliably. This is common for libraries that propagate errors to callers by design "
                   "(for example via callbacks or `next(err)`). Per-category evidence is still included.")
    else:
        g, text = grade(score)
        conf, why = confidence(agg, cats)
        final = {"score": round(score, 1), "grade": g, "interpretation": text,
                 "confidence": conf, "confidence_reason": why}
        if conf == "low":
            warnings.append("Low confidence: " + why)
        summary = _summary(score, g, cats, eff, agg, langs, missing)

    return {
        "tool": {"name": "error-handling-scorer", "version": __version__},
        "repository": {"input": info.input_spec, "url": info.url, "commit": info.commit,
                       "branch": info.branch, "source": info.source,
                       "analysis_timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat()},
        "final_score": final,
        "summary": summary,
        "categories": cat_out,
        "highlights": build_highlights(agg, cats),
        "issues": build_issues(agg, cats, top),
        "metrics": {
            "files_analyzed": agg.files, "lines_of_code": agg.loc,
            "test_files_excluded": 0 if include_tests else sum(1 for r in results if r.is_test),
            "languages": agg.languages,
            "error_handlers": int(agg.c["handlers"]), "try_blocks": int(agg.c["tries"]),
            "with_statements": int(agg.c["with_stmts"]), "finally_or_defer": int(agg.c["tries_finally"]),
            "raise_statements": int(agg.c["raises"]),
        },
        "analysis": {"duration_seconds": round(duration, 2), "files_skipped": dict(sorted(skipped.items()))},
        "warnings": warnings,
        "limitations": LIMITATIONS,
    }


def write_json_atomic(path: str, data: Dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ehscore-", suffix=".tmp", dir=directory)
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


def render_summary(rep: Dict[str, Any], out_path: str) -> str:
    f = rep["final_score"]
    lines = ["", f"Error-handling report for {rep['repository']['url'] or rep['repository']['input']}"]
    if rep["repository"].get("commit"):
        lines.append(f"  commit {rep['repository']['commit'][:12]}")
    sc = "n/a" if f["score"] is None else f"{f['score']:.1f}/100 (grade {f['grade']})"
    if f.get("confidence"):
        sc += f", confidence: {f['confidence']}"
    lines += [f"  Final score: {sc}", f"  {f['interpretation']}", "", "  Category                                          Score  Weight"]
    for c in rep["categories"].values():
        s = "  n/a" if c["score"] is None else f"{c['score']:5.1f}"
        lines.append(f"  {c['label']:<48} {s}   {c['weight']:.2f}")
    if rep["highlights"]:
        lines += ["", "  Highlights:"] + [f"    + {h}" for h in rep["highlights"][:4]]
    if rep["issues"]:
        lines += ["", "  Top issues:"] + [f"    - [{i['severity']}] {i['description']} ({i['count']})"
                                          for i in rep["issues"][:4]]
    lines += ["", f"  Full report: {out_path}"]
    return "\n".join(lines)
