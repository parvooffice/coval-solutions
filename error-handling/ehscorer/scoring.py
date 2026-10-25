"""Weighted scoring, highlights and issues derived from aggregated counters."""

from __future__ import annotations

import builtins
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from .metrics import FileResult, Finding

WEIGHTS: Dict[str, float] = {
    "exception_specificity": 0.17,
    "handler_quality": 0.18,
    "error_propagation": 0.12,
    "custom_exceptions": 0.08,
    "input_validation": 0.15,
    "resource_cleanup": 0.15,
    "critical_path_coverage": 0.15,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9

LABELS = {
    "exception_specificity": "Exception specificity",
    "handler_quality": "Handler quality (logging / meaningful handling)",
    "error_propagation": "Propagation vs. swallowing",
    "custom_exceptions": "Custom exception classes",
    "input_validation": "Input validation & defensive programming",
    "resource_cleanup": "Resource cleanup",
    "critical_path_coverage": "Error handling on critical paths",
}
CRITERIA = {
    "exception_specificity": "Share of handlers that target specific exception types. Bare `except:` scores 0, "
                             "`except Exception` scores 0.25 (0.6 if it logs or re-raises), specific types 1.0.",
    "handler_quality": "What handlers do with the error: log/re-raise = 1.0, print/use the exception = 0.7, "
                       "other fallback = 0.4-0.6, silently ignoring = 0-0.25 (idiomatic cases such as optional "
                       "ImportError are exempt).",
    "error_propagation": "Low share of silently swallowed errors (45%), exceptions re-raised with their cause "
                         "preserved (`raise ... from e`, `%w`, `cause`) (30%), and not raising bare "
                         "Exception/RuntimeException (25%).",
    "custom_exceptions": "Domain-specific exception types: how many exist relative to code size, whether they "
                         "share a base class, and whether they are actually raised or caught. Not scored for "
                         "tiny code bases.",
    "input_validation": "Share of non-trivial public functions that validate arguments (guard clauses that "
                        "raise, validating decorators) and share of all non-trivial functions with defensive "
                        "checks (isinstance, None checks, assert, defaults).",
    "resource_cleanup": "Resources (files, sockets, connections, processes) acquired via `with` / "
                        "try-with-resources / `defer` vs. closed manually vs. never closed, plus how often "
                        "with/finally/context managers are used.",
    "critical_path_coverage": "Share of risky operations (file I/O, network, parsing, subprocess, database) that "
                              "sit inside a try block, a `with` context, or a Java method declaring `throws`, plus network calls "
                              "that set a timeout.",
}


def lin_up(x: float, bad: float, good: float) -> float:
    if x <= bad:
        return 0.0
    if x >= good:
        return 1.0
    return (x - bad) / (good - bad)


def lin_down(x: float, good: float, bad: float) -> float:
    return 1.0 - lin_up(x, good, bad)


def wmean(parts: List[Tuple[Optional[float], float]]) -> Optional[float]:
    use = [(v, w) for v, w in parts if v is not None]
    tw = sum(w for _, w in use)
    return sum(v * w for v, w in use) / tw if tw else None


@dataclass
class Aggregate:
    c: Counter = field(default_factory=Counter)
    findings: List[Finding] = field(default_factory=list)
    classes: List[Tuple[str, Tuple[str, ...], str]] = field(default_factory=list)
    used_names: Set[str] = field(default_factory=set)
    loc: int = 0
    files: int = 0
    languages: Dict[str, Dict[str, int]] = field(default_factory=dict)
    per_file: Dict[str, Dict[str, float]] = field(default_factory=dict)

    @classmethod
    def build(cls, results: List[FileResult]) -> "Aggregate":
        agg = cls()
        for r in sorted(results, key=lambda x: x.path):
            agg.files += 1
            agg.loc += r.loc
            agg.c.update(r.c)
            agg.findings.extend(r.findings)
            agg.classes.extend((n, b, r.path) for n, b in r.classes)
            agg.used_names |= r.used_names
            lang = agg.languages.setdefault(r.language, {"files": 0, "loc": 0})
            lang["files"] += 1
            lang["loc"] += r.loc
            agg.per_file[r.path] = r.c
        return agg


_BUILTIN_EXC = {n for n, v in vars(builtins).items() if isinstance(v, type) and issubclass(v, BaseException)}
_EXC_SUFFIX = ("Error", "Exception", "Warning", "Throwable")


def resolve_custom_exceptions(classes) -> Tuple[Dict[str, str], Set[str]]:
    """Return ({custom_name: path}, names_with_custom_parent)."""
    by_name = {n: (b, p) for n, b, p in classes}
    custom: Dict[str, str] = {}
    changed = True
    while changed:
        changed = False
        for name, (bases, path) in by_name.items():
            if name in custom:
                continue
            if any(b in _BUILTIN_EXC or b.endswith(_EXC_SUFFIX) or b in custom for b in bases):
                custom[name] = path
                changed = True
    children = {n for n in custom if any(b in custom for b in by_name[n][0])}
    return custom, children


@dataclass
class CategoryResult:
    key: str
    score: Optional[float] = None  # 0..1
    evidence: Dict[str, Any] = field(default_factory=dict)
    note: Optional[str] = None


def _r(x: Optional[float], n: int = 3) -> Optional[float]:
    return None if x is None else round(x, n)


def score_categories(agg: Aggregate) -> Dict[str, CategoryResult]:
    c = agg.c
    kloc = max(agg.loc, 1) / 1000.0
    out: Dict[str, CategoryResult] = {k: CategoryResult(k) for k in WEIGHTS}
    H = c["handlers"]

    # 1 specificity -------------------------------------------------------
    s = out["exception_specificity"]
    s.evidence = {"handlers": int(H), "specific": int(c["h_specific"]), "untyped_language_catch": int(c["h_untyped"]),
                  "broad": int(c["h_broad"]), "bare": int(c["h_bare"])}
    if H >= 3:
        s.score = c["h_spec_sum"] / H
    else:
        s.note = f"only {int(H)} error handler(s) found; need at least 3 to judge specificity"

    # 2 handler quality ---------------------------------------------------
    q = out["handler_quality"]
    q.evidence = {"handlers": int(H), "log_or_report": int(c["h_log"]), "propagate": int(c["h_propagate"]),
                  "silently_swallowed": int(c["h_silent"]), "idiomatic_ignores": int(c["h_idiomatic"])}
    if H >= 3:
        q.score = c["h_qual_sum"] / H
    else:
        q.note = s.note

    # 3 propagation ---------------------------------------------------------
    p = out["error_propagation"]
    silent_ratio = c["h_silent"] / H if H else None
    chain = c["h_new_chained"] / c["h_new_raise"] if c["h_new_raise"] >= 3 else None
    generic = 1 - c["raise_generic"] / c["raises"] if c["raises"] >= 5 else None
    p.evidence = {"silent_swallow_ratio": _r(silent_ratio), "new_raises_in_handlers": int(c["h_new_raise"]),
                  "chained_with_cause": int(c["h_new_chained"]), "chain_ratio": _r(chain),
                  "generic_raise_count": int(c["raise_generic"]), "raises": int(c["raises"])}
    p.score = wmean([
        (lin_down(silent_ratio, 0.0, 0.25) if H >= 3 and silent_ratio is not None else None, 0.45),
        (chain, 0.30),
        (generic, 0.25),
    ])
    if p.score is None:
        p.note = "not enough handlers or raise statements to judge propagation"

    # 4 custom exceptions ------------------------------------------------------
    ce = out["custom_exceptions"]
    custom, children = resolve_custom_exceptions(agg.classes)
    used = {n for n in custom if n in agg.used_names}
    n_custom = len(custom)
    ce.evidence = {"custom_exception_classes": n_custom, "with_shared_base": len(children),
                   "raised_or_caught": len(used), "examples": sorted(custom)[:8]}
    if agg.loc < 1500 and n_custom == 0:
        ce.note = "small code base (<1500 LOC) with no custom exceptions; not penalized"
    else:
        expected = min(8.0, max(1.0, kloc / 4))
        presence = min(1.0, n_custom / expected)
        hierarchy = 1.0 if (n_custom >= 2 and children) else (0.5 if n_custom >= 1 else 0.0)
        usage = len(used) / n_custom if n_custom else 0.0
        ce.score = 0.5 * presence + 0.2 * hierarchy + 0.3 * usage

    # 5 validation ----------------------------------------------------------------
    v = out["input_validation"]
    vr = c["funcs_validated"] / c["funcs_public"] if c["funcs_public"] >= 5 else None
    dr = c["funcs_defensive"] / c["funcs_nontrivial"] if c["funcs_nontrivial"] >= 5 else None
    v.evidence = {"public_functions_checked": int(c["funcs_public"]), "validating": int(c["funcs_validated"]),
                  "validation_ratio": _r(vr), "nontrivial_functions": int(c["funcs_nontrivial"]),
                  "defensive_ratio": _r(dr)}
    v.score = wmean([
        (lin_up(vr, 0.03, 0.30) if vr is not None else None, 0.6),
        (lin_up(dr, 0.10, 0.55) if dr is not None else None, 0.4),
    ])
    if v.score is None:
        v.note = "fewer than 5 functions to evaluate"

    # 6 resource cleanup ------------------------------------------------------------
    rc = out["resource_cleanup"]
    managed, manual, bad = c["res_with"], c["res_manual"], c["res_unmanaged"]
    total = managed + manual + bad
    usage_count = c["with_stmts"] + c["tries_finally"] + c["ctx_defs"]
    density = usage_count / kloc
    rc.evidence = {"resources_acquired": int(total), "managed_with_context": int(managed),
                   "closed_manually": int(manual), "never_closed": int(bad),
                   "with_or_finally_or_context_manager_per_kloc": _r(density, 2),
                   "context_manager_definitions": int(c["ctx_defs"])}
    rc.score = wmean([
        (((managed + 0.5 * manual) / total) if total >= 1 else None, 0.7),
        (lin_up(density, 0.2, 2.5) if (total >= 1 or c["risky_io"] + c["risky_proc"] + c["risky_db"] >= 5) else None, 0.3),
    ])
    if rc.score is None:
        rc.note = "no resources (files, sockets, connections) or I/O-heavy code detected; not scored"

    # 7 critical paths --------------------------------------------------------------------
    cp = out["critical_path_coverage"]
    R = c["risky_total"]
    cov = c["risky_covered"] / R if R else None
    net_t = c["net_total"]
    timeout_ok = 1 - c["net_no_timeout"] / net_t if net_t >= 1 else None
    cats = {}
    for cat in ("io", "net", "parse", "proc", "db"):
        t = c["risky_" + cat]
        if t:
            cats[cat] = {"calls": int(t), "in_try": int(c["riskycov_" + cat]),
                         "coverage": _r(c["riskycov_" + cat] / t)}
    cp.evidence = {"risky_calls": int(R), "protected": int(c["risky_covered"]), "coverage": _r(cov),
                   "by_category": cats, "network_calls": int(net_t),
                   "network_calls_without_timeout": int(c["net_no_timeout"])}
    cp.score = wmean([
        (lin_up(cov, 0.10, 0.65) if R >= 5 else None, 0.8),
        (timeout_ok, 0.2),
    ])
    if cp.score is None:
        cp.note = "fewer than 5 risky operations (I/O, network, parsing, subprocess, DB) detected"
    return out


def grade(score: float) -> Tuple[str, str]:
    if score >= 85:
        return "A", "Excellent: specific, informative handling with clean propagation and cleanup."
    if score >= 72:
        return "B", "Good: solid practices with some gaps worth tightening."
    if score >= 58:
        return "C", "Fair: mixed practices; several swallowed or overly broad handlers."
    if score >= 45:
        return "D", "Weak: error handling is inconsistent and often hides failures."
    return "F", "Poor: little structured error handling, or widespread anti-patterns."


def overall(cats: Dict[str, CategoryResult]) -> Tuple[Optional[float], Dict[str, float]]:
    avail = {k: r for k, r in cats.items() if r.score is not None}
    tw = sum(WEIGHTS[k] for k in avail)
    if not tw:
        return None, {k: 0.0 for k in cats}
    eff = {k: (WEIGHTS[k] / tw if k in avail else 0.0) for k in cats}
    return 100.0 * sum(r.score * eff[k] for k, r in avail.items()), eff


# ---------------------------------------------------------------------------
# Highlights & issues
# ---------------------------------------------------------------------------

_ISSUE_TEXT = {
    "bare_except": ("high", "Bare `except:` clauses catch everything, including KeyboardInterrupt and SystemExit"),
    "swallowed_exception": ("high", "Exceptions silently swallowed (empty handler / pass / continue)"),
    "swallowed_error": ("high", "Go errors checked but dropped with an empty handler"),
    "ignored_error": ("high", "Go error return values explicitly discarded with `_`"),
    "broad_except_no_handling": ("medium", "Broad `except Exception` / `catch (Exception)` without logging or re-raising"),
    "raise_without_cause": ("low", "New exceptions raised inside handlers without preserving the original cause"),
    "error_not_wrapped": ("low", "Go errors re-created with fmt.Errorf without `%w`, losing the error chain"),
    "raise_generic_exception": ("low", "Generic Exception/RuntimeException raised instead of a specific or custom type"),
    "unclosed_resource": ("medium", "Resources opened without `with` / try-with-resources / defer and never closed"),
    "network_no_timeout": ("medium", "Network calls made without a timeout (can hang indefinitely)"),
    "unprotected_call": ("medium", "Risky operations (I/O, network, parsing, subprocess) outside any error handling"),
}
_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def build_issues(agg: Aggregate, cats: Dict[str, CategoryResult], top: int) -> List[Dict[str, Any]]:
    by_kind: Dict[str, List[Finding]] = defaultdict(list)
    for f in agg.findings:
        by_kind[f.kind].append(f)
    issues = []
    for kind, (sev, text) in _ISSUE_TEXT.items():
        total = int(agg.c.get("f." + kind, 0))
        if not total:
            continue
        if kind == "unprotected_call" and total < 5:
            continue
        ex = by_kind.get(kind, [])
        # spread examples across files rather than showing one noisy file
        seen: Counter = Counter()
        picked = []
        for f in sorted(ex, key=lambda f: (seen[f.path], f.path, f.line)):
            if seen[f.path] >= 2:
                continue
            seen[f.path] += 1
            picked.append(f)
            if len(picked) >= top:
                break
        issues.append({
            "type": kind, "severity": sev, "count": total, "description": text,
            "examples": [{"location": f"{f.path}:{f.line}", "detail": f.note} for f in picked],
        })
    ce = cats["custom_exceptions"]
    if ce.score is not None and ce.evidence["custom_exception_classes"] == 0 and agg.loc >= 2000:
        issues.append({"type": "no_custom_exceptions", "severity": "low", "count": 0,
                       "description": f"No custom exception types in {agg.loc:,} lines of code; callers cannot "
                                      "distinguish domain failures from generic ones", "examples": []})
    vr = cats["input_validation"].evidence.get("validation_ratio")
    if vr is not None and vr < 0.05:
        issues.append({"type": "little_input_validation", "severity": "medium", "count": 0,
                       "description": f"Only {vr:.0%} of non-trivial public functions validate their inputs",
                       "examples": []})
    issues.sort(key=lambda i: (_SEVERITY_ORDER[i["severity"]], -i["count"]))
    return issues


def build_highlights(agg: Aggregate, cats: Dict[str, CategoryResult]) -> List[str]:
    c = agg.c
    out: List[str] = []
    H = c["handlers"]
    if H >= 3:
        sp = (c["h_specific"] + c["h_untyped"]) / H
        if c["h_specific"] / H >= 0.7:
            out.append(f"{c['h_specific'] / H:.0%} of {int(H)} handlers catch specific exception types")
        if c["h_bare"] == 0 and c["h_broad"] / H < 0.1 and c["h_untyped"] < H:
            out.append("No bare `except:` clauses and very few catch-all handlers")
        if (c["h_log"] + c["h_propagate"]) / H >= 0.7:
            out.append(f"{(c['h_log'] + c['h_propagate']) / H:.0%} of handlers log the error or re-raise it")
        if c["h_silent"] == 0:
            out.append("No silently swallowed exceptions detected")
    if c["h_new_raise"] >= 3 and c["h_new_chained"] / c["h_new_raise"] >= 0.7:
        out.append(f"Exception chaining is used consistently ({int(c['h_new_chained'])} of "
                   f"{int(c['h_new_raise'])} re-raises preserve the cause)")
    ce = cats["custom_exceptions"].evidence
    if ce["custom_exception_classes"] >= 3:
        base = " with a shared base class" if ce["with_shared_base"] else ""
        out.append(f"{ce['custom_exception_classes']} custom exception classes{base} "
                   f"(e.g. {', '.join(ce['examples'][:3])})")
    ev = cats["input_validation"].evidence
    if ev.get("validation_ratio") is not None and ev["validation_ratio"] >= 0.25:
        out.append(f"{ev['validation_ratio']:.0%} of non-trivial public functions validate their inputs")
    rc = cats["resource_cleanup"].evidence
    if rc["resources_acquired"] >= 3 and rc["never_closed"] == 0:
        out.append(f"All {rc['resources_acquired']} detected resources are closed via with/defer/close")
    if rc["context_manager_definitions"]:
        out.append(f"Defines {rc['context_manager_definitions']} reusable context manager(s)/closeable type(s)")
    cp = cats["critical_path_coverage"].evidence
    if cp["coverage"] is not None and cp["risky_calls"] >= 5 and cp["coverage"] >= 0.6:
        out.append(f"{cp['coverage']:.0%} of {cp['risky_calls']} risky operations (I/O, network, parsing, ...) "
                   "are wrapped in error handling")
    if cp["network_calls"] >= 3 and cp["network_calls_without_timeout"] == 0:
        out.append(f"All {cp['network_calls']} network calls set a timeout")
    if c["errors_is_as"] >= 3:
        out.append(f"Uses errors.Is/errors.As {int(c['errors_is_as'])} times for typed error inspection")
    return out


def confidence(agg: Aggregate, cats: Dict[str, CategoryResult]) -> Tuple[str, str]:
    """How much evidence the score rests on."""
    n_scored = sum(1 for r in cats.values() if r.score is not None)
    handlers = agg.c["handlers"]
    if n_scored >= 5 and handlers >= 30:
        return "high", "scored on at least 5 categories and 30+ error handlers"
    if n_scored >= 4 and handlers >= 10:
        return "medium", "scored on 4+ categories and 10+ error handlers"
    return "low", (f"only {n_scored} of {len(cats)} categories had enough evidence and {int(handlers)} error "
                   "handler(s) were found; treat the score as indicative only")
