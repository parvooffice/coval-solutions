"""Turn per-file metrics and the dependency graph into weighted modularity scores.

Every dimension returns a 0-1 score built from smooth, piecewise-linear
components (``lin_down`` / ``lin_up``) so that one threshold crossing never
flips a score abruptly. Components that cannot be evaluated (too little data)
are dropped and the remaining weights are renormalised; the report says so.
"""

from __future__ import annotations

import math
import posixpath
import re
import statistics
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

from .graph import GraphInfo
from .models import FileMetrics

WEIGHTS: Dict[str, float] = {
    "file_level": 0.15,
    "function_cohesion": 0.20,
    "coupling": 0.25,
    "package_structure": 0.15,
    "encapsulation": 0.10,
    "code_organization": 0.15,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9

DIMENSION_LABELS = {
    "file_level": "File-level modularity",
    "function_cohesion": "Function / method cohesion",
    "coupling": "Coupling",
    "package_structure": "Package / module structure",
    "encapsulation": "Encapsulation",
    "code_organization": "Code organization signals",
}

# Languages whose idioms legitimately produce bigger files / functions.
FILE_SCALE = {"java": 1.5, "c": 1.5, "cpp": 1.5, "go": 1.2}
FUNC_SCALE = {"java": 1.3, "c": 1.3, "cpp": 1.3, "go": 1.2}

LAYER_VOCAB = {
    "domain": {"domain", "domains", "entities", "entity", "model", "models", "core", "business"},
    "application": {"application", "services", "service", "usecases", "use_cases", "usecase",
                    "interactors", "commands", "queries"},
    "infrastructure": {"infrastructure", "infra", "adapters", "adapter", "repositories",
                       "repository", "persistence", "db", "database", "storage", "gateways",
                       "clients", "integrations"},
    "presentation": {"presentation", "api", "controllers", "controller", "routes", "routers",
                     "views", "web", "ui", "cli", "rest", "http", "transport", "grpc"},
}
FORBIDDEN_LAYER_EDGES = {
    ("domain", "application"), ("domain", "infrastructure"), ("domain", "presentation"),
    ("application", "presentation"), ("infrastructure", "presentation"),
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def lin_down(x: float, good: float, bad: float) -> float:
    """1.0 when x <= good, 0.0 when x >= bad, linear in between."""
    if x <= good:
        return 1.0
    if x >= bad:
        return 0.0
    return (bad - x) / (bad - good)


def lin_up(x: float, bad: float, good: float) -> float:
    """0.0 when x <= bad, 1.0 when x >= good, linear in between."""
    if x <= bad:
        return 0.0
    if x >= good:
        return 1.0
    return (x - bad) / (good - bad)


def combine(parts: Dict[str, Tuple[Optional[float], float]]) -> Optional[float]:
    """Weighted mean over components that produced a value."""
    total_w = sum(w for v, w in parts.values() if v is not None)
    if total_w <= 0:
        return None
    return sum(v * w for v, w in parts.values() if v is not None) / total_w


def _pct(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = min(len(ordered) - 1, max(0, int(math.ceil(q * len(ordered))) - 1))
    return ordered[k]


def _r(x: Optional[float], nd: int = 3) -> Optional[float]:
    return None if x is None else round(x, nd)


def _wmean(pairs: List[Tuple[float, float]]) -> float:
    tw = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / tw if tw else 0.0


class Dimension:
    """Result container for one scored dimension."""

    def __init__(self, key: str) -> None:
        self.key = key
        self.score: Optional[float] = None
        self.components: Dict[str, Dict[str, Any]] = {}
        self.details: Dict[str, Any] = {}
        self.note: Optional[str] = None

    def set(self, parts: Dict[str, Tuple[Optional[float], float, Any]]) -> None:
        """parts: name -> (score|None, weight, raw_value)."""
        for name, (score, weight, raw) in parts.items():
            self.components[name] = {"score": _r(score), "weight": weight, "value": raw}
        self.score = combine({k: (v[0], v[1]) for k, v in parts.items()})


# --------------------------------------------------------------------------
# 1. file level
# --------------------------------------------------------------------------

def file_health(f: FileMetrics) -> Tuple[float, float, bool]:
    """(size_score, defs_score, is_god_file) for one file."""
    s = FILE_SCALE.get(f.language, 1.0)
    defs = len(f.functions) + f.classes
    size_s = lin_down(f.loc, 200 * s, 1000 * s)
    defs_s = lin_down(defs, 15 * s, 60 * s)
    god = (
        f.loc >= 1500 * s
        or defs >= 80 * s
        or len(f.functions) >= 60 * s
        or f.max_class_methods >= 50
    )
    return size_s, defs_s, god


def score_file_level(files: List[FileMetrics]) -> Dimension:
    dim = Dimension("file_level")
    if not files:
        return dim
    pairs, god_files = [], []
    for f in files:
        size_s, defs_s, god = file_health(f)
        pairs.append((0.6 * size_s + 0.4 * defs_s, math.sqrt(max(f.loc, 1))))
        if god:
            god_files.append(f.path)
    mean = _wmean(pairs)
    god_frac = len(god_files) / len(files)
    locs = [f.loc for f in files]
    dim.set({
        "size_and_density": (mean, 0.70, None),
        "god_file_penalty": (lin_down(god_frac, 0.0, 0.05), 0.30, _r(god_frac, 4)),
    })
    dim.details = {
        "avg_loc": _r(statistics.fmean(locs), 1),
        "median_loc": statistics.median(locs),
        "p90_loc": _pct(locs, 0.9),
        "max_loc": max(locs),
        "avg_definitions_per_file": _r(statistics.fmean(len(f.functions) + f.classes for f in files), 1),
        "god_files": len(god_files),
        "god_file_examples": sorted(god_files)[:10],
    }
    return dim


# --------------------------------------------------------------------------
# 2. function cohesion
# --------------------------------------------------------------------------

def function_health(language: str, lines: int, cc: int, params: int) -> float:
    s = FUNC_SCALE.get(language, 1.0)
    return (
        0.40 * lin_down(lines, 30 * s, 150 * s)
        + 0.45 * lin_down(cc, 8, 30)
        + 0.15 * lin_down(params, 5, 10)
    )


def score_function_cohesion(files: List[FileMetrics]) -> Dimension:
    dim = Dimension("function_cohesion")
    funcs = [(f, fn) for f in files for fn in f.functions]
    if len(funcs) < 5:
        dim.note = "fewer than 5 functions found; dimension not scored"
        return dim
    pairs, bad = [], 0
    for f, fn in funcs:
        pairs.append((function_health(f.language, fn.lines, fn.complexity, fn.params),
                      math.sqrt(max(fn.lines, 1))))
        s = FUNC_SCALE.get(f.language, 1.0)
        if fn.lines > 100 * s or fn.complexity > 20:
            bad += 1
    bad_frac = bad / len(funcs)
    lengths = [fn.lines for _, fn in funcs]
    ccs = [fn.complexity for _, fn in funcs]
    dim.set({
        "length_complexity_params": (_wmean(pairs), 0.60, None),
        "oversized_or_complex_penalty": (lin_down(bad_frac, 0.0, 0.10), 0.40, _r(bad_frac, 4)),
    })
    dim.details = {
        "functions_analyzed": len(funcs),
        "avg_function_lines": _r(statistics.fmean(lengths), 1),
        "p90_function_lines": _pct(lengths, 0.9),
        "avg_cyclomatic_complexity": _r(statistics.fmean(ccs), 2),
        "p90_cyclomatic_complexity": _pct(ccs, 0.9),
        "functions_over_100_lines": sum(1 for v in lengths if v > 100),
        "functions_complexity_over_20": sum(1 for v in ccs if v > 20),
        "avg_parameters": _r(statistics.fmean(fn.params for _, fn in funcs), 2),
    }
    return dim


# --------------------------------------------------------------------------
# 3. coupling
# --------------------------------------------------------------------------

def score_coupling(files: List[FileMetrics], graph: GraphInfo) -> Dimension:
    dim = Dimension("coupling")
    n = graph.nodes
    if n < 3:
        dim.note = "fewer than 3 files; coupling not scored"
        return dim
    avg_out = graph.edges / n
    high_out = sum(1 for v in graph.fan_out.values() if v > 20) / n
    cyc_frac = len(graph.cyclic_nodes) / n
    largest = len(graph.sccs[0]) if graph.sccs else 0
    cycles_score = 0.7 * lin_down(cyc_frac, 0.0, 0.25) + 0.3 * lin_down(largest / n, 0.0, 0.20)
    good_depth = 5 + 1.2 * math.log2(n + 1)
    depth_score = lin_down(graph.depth, good_depth, 2.5 * good_depth)
    max_in = max(graph.fan_in.values(), default=0)
    hub_score = lin_down(max_in / n, 0.25, 0.70) if n >= 20 else None
    avg_ext = statistics.fmean(graph.external_deps.values()) if graph.external_deps else 0.0

    dim.set({
        "avg_internal_fan_out": (lin_down(avg_out, 4, 14), 0.30, _r(avg_out, 2)),
        "excessive_fan_out_files": (lin_down(high_out, 0.0, 0.08), 0.10, _r(high_out, 4)),
        "import_cycles": (cycles_score, 0.30, {"files_in_cycles": len(graph.cyclic_nodes),
                                               "cycles": len(graph.sccs)}),
        "dependency_depth": (depth_score, 0.15, graph.depth),
        "god_dependency": (hub_score, 0.05, _r(max_in / n, 3)),
        "external_dependency_density": (lin_down(avg_ext, 6, 25), 0.10, _r(avg_ext, 2)),
    })
    dim.details = {
        "graph_nodes": n,
        "graph_edges": graph.edges,
        "avg_fan_out": _r(avg_out, 2),
        "max_fan_out": max(graph.fan_out.values(), default=0),
        "max_fan_in": max_in,
        "circular_dependency_groups": len(graph.sccs),
        "files_in_cycles": len(graph.cyclic_nodes),
        "largest_cycle_size": largest,
        "max_import_depth": graph.depth,
    }
    if graph.edges == 0 and n >= 5:
        dim.note = ("no internal imports could be resolved; coupling figures may be "
                    "unreliable (unsupported module system, aliases or generated imports?)")
    return dim


# --------------------------------------------------------------------------
# 4. package / module structure
# --------------------------------------------------------------------------

def _dir_parts(path: str, language: str) -> List[str]:
    parts = path.split("/")[:-1]
    if language == "java":
        for i in range(len(parts) - 2):
            if parts[i] == "src" and parts[i + 1] in {"main", "test"} and parts[i + 2] in {"java", "kotlin"}:
                parts = parts[i + 3:]
                break
        if parts and parts[0] in {"com", "org", "net", "io", "edu", "gov"}:
            parts = parts[2:]
    return parts


def detect_layer(path: str) -> Optional[str]:
    for comp in reversed(path.split("/")[:-1]):
        c = comp.lower()
        for layer, vocab in LAYER_VOCAB.items():
            if c in vocab:
                return layer
    return None


def score_package_structure(files: List[FileMetrics], graph: GraphInfo) -> Dimension:
    dim = Dimension("package_structure")
    n = len(files)
    if n < 8:
        dim.note = "fewer than 8 files; directory structure not scored"
        dim.details = {"files": n}
        return dim

    parts_list = [_dir_parts(f.path, f.language) for f in files]
    common = 0
    first = parts_list[0]
    for i in range(len(first)):
        if all(len(p) > i and p[i] == first[i] for p in parts_list):
            common += 1
        else:
            break
    depths = [max(0, len(p) - common) for p in parts_list]
    avg_depth = statistics.fmean(depths)
    p95 = _pct(depths, 0.95)
    nesting = 0.6 * lin_down(avg_depth, 3.5, 6.5) + 0.4 * lin_down(p95, 6, 12)

    dir_counts = Counter(posixpath.dirname(f.path) for f in files)
    crowded = sum(c for c in dir_counts.values() if c > 25) / n
    flat = lin_down(crowded, 0.15, 0.65)

    layers_found = {l for l in (detect_layer(f.path) for f in files) if l}
    layer_score = {0: 0.35, 1: 0.5, 2: 0.75}.get(len(layers_found), 1.0)

    layer_edges = violations = 0
    for src, targets in graph.adj.items():
        ls = detect_layer(src)
        if not ls:
            continue
        for t in targets:
            lt = detect_layer(t)
            if lt and lt != ls:
                layer_edges += 1
                if (ls, lt) in FORBIDDEN_LAYER_EDGES:
                    violations += 1
    viol_score = None
    viol_ratio = None
    if len(layers_found) >= 2 and layer_edges >= 10:
        viol_ratio = violations / layer_edges
        viol_score = lin_down(viol_ratio, 0.0, 0.10)

    intra = cohesion = None
    if graph.edges >= 5:
        same = sum(1 for s, ts in graph.adj.items() for t in ts
                   if posixpath.dirname(s) == posixpath.dirname(t))
        intra = same / graph.edges
        cohesion = lin_up(intra, 0.05, 0.35)

    dim.set({
        "directory_nesting": (nesting, 0.25, {"avg_depth": _r(avg_depth, 2), "p95_depth": p95}),
        "avoids_flat_dumping_ground": (flat, 0.25, _r(crowded, 3)),
        "layer_separation": (layer_score, 0.15, sorted(layers_found)),
        "layer_dependency_direction": (viol_score, 0.15, _r(viol_ratio, 4)),
        "intra_package_cohesion": (cohesion, 0.20, _r(intra, 3)),
    })
    dim.details = {
        "directories_with_code": len(dir_counts),
        "avg_files_per_directory": _r(n / len(dir_counts), 1),
        "max_files_in_directory": max(dir_counts.values()),
        "layers_detected": sorted(layers_found),
        "layer_violations": violations,
        "layered_edges": layer_edges,
    }
    return dim


# --------------------------------------------------------------------------
# 5. encapsulation
# --------------------------------------------------------------------------

def score_encapsulation(files: List[FileMetrics]) -> Dimension:
    dim = Dimension("encapsulation")
    members = [f for f in files if f.public_members + f.private_members >= 3]
    iface = [s for f in files for s in f.interface_sizes]
    if len(members) < 3 and not iface:
        dim.note = "too few classified members; dimension not scored"
        return dim

    privacy = surface = None
    ratio = wide = None
    if len(members) >= 3:
        total_priv = sum(f.private_members for f in members)
        total_all = sum(f.public_members + f.private_members for f in members)
        ratio = total_priv / total_all
        privacy = lin_up(ratio, 0.05, 0.45)
        wide = sum(1 for f in members if f.public_members > 25) / len(members)
        surface = lin_down(wide, 0.02, 0.20)

    isp = fat = avg_iface = None
    if iface:
        fat = sum(1 for s in iface if s > 10) / len(iface)
        avg_iface = statistics.fmean(iface)
        isp = 0.5 * lin_down(fat, 0.05, 0.40) + 0.5 * lin_down(avg_iface, 5, 15)

    dim.set({
        "private_member_ratio": (privacy, 0.50, _r(ratio, 3)),
        "narrow_public_surface": (surface, 0.25, _r(wide, 3)),
        "interface_segregation": (isp, 0.25, _r(avg_iface, 2)),
    })
    dim.details = {
        "files_with_classified_members": len(members),
        "interfaces_found": len(iface),
        "fat_interfaces_over_10_members": sum(1 for s in iface if s > 10),
    }
    return dim


# --------------------------------------------------------------------------
# 6. code organization
# --------------------------------------------------------------------------

_SNAKE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")
_KEBAB = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$")
_CAMEL = re.compile(r"^[a-z]+[a-z0-9]*[A-Z][A-Za-z0-9]*$")
_PASCAL = re.compile(r"^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)*$")
_UPPER = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
_MIX_CAMEL_PASCAL = {"go", "java", "javascript", "typescript"}


def name_style(name: str, merge_camel_pascal: bool) -> Optional[str]:
    """Classify an identifier; single-word lowercase names are style-neutral."""
    name = name.strip("_$#")
    if not name or name.startswith("<"):
        return None
    if _SNAKE.match(name):
        return "snake"
    if _KEBAB.match(name):
        return "kebab"
    if _UPPER.match(name):
        return "upper"
    if _CAMEL.match(name):
        return "camel/pascal" if merge_camel_pascal else "camel"
    if _PASCAL.match(name) and len(name) > 1 and not name.isupper():
        return "camel/pascal" if merge_camel_pascal else "pascal"
    return None


def _dominance(counts_by_lang: Dict[str, Counter]) -> Tuple[Optional[float], int]:
    dominant = total = 0
    for counter in counts_by_lang.values():
        n = sum(counter.values())
        if n >= 5:
            dominant += max(counter.values())
            total += n
    return (dominant / total, total) if total >= 10 else (None, total)


def _is_test_helper_name(name: str) -> bool:
    return name.startswith("test") or name.startswith("Test")


def score_code_organization(
    files: List[FileMetrics], graph: GraphInfo, all_files: List[FileMetrics]
) -> Dimension:
    dim = Dimension("code_organization")
    n = len(files)
    if n < 3:
        dim.note = "fewer than 3 files; dimension not scored"
        return dim

    # naming consistency ------------------------------------------------
    file_styles: Dict[str, Counter] = defaultdict(Counter)
    func_styles: Dict[str, Counter] = defaultdict(Counter)
    for f in files:
        merge = f.language in _MIX_CAMEL_PASCAL
        stem = posixpath.splitext(posixpath.basename(f.path))[0]
        if stem not in {"__init__", "__main__", "index"}:
            st = name_style(stem, merge)
            if st:
                file_styles[f.language][st] += 1
        for fn in f.functions:
            if fn.name.startswith("__") or fn.name == "<anonymous>":
                continue
            st = name_style(fn.name, merge)
            if st and st != "upper":
                func_styles[f.language][st] += 1
    file_dom, file_total = _dominance(file_styles)
    func_dom, func_total = _dominance(func_styles)
    naming = combine({
        "files": (lin_up(file_dom, 0.55, 0.95) if file_dom is not None else None, 0.4),
        "functions": (lin_up(func_dom, 0.60, 0.95) if func_dom is not None else None, 0.6),
    })

    # separation of concerns -------------------------------------------
    mixed = []
    for f in files:
        concerns = f.infra & {"db", "http", "web"}
        logic = sum(fn.complexity for fn in f.functions)
        if len(concerns) >= 2 and logic >= 25:
            mixed.append(f.path)
    mixed_frac = len(mixed) / n
    soc = lin_down(mixed_frac, 0.03, 0.30)

    # entry points ------------------------------------------------------
    entries = [f for f in files if f.is_entry_point]
    if entries:
        avg_entry_loc = statistics.fmean(f.loc for f in entries)
        entry_score = lin_down(avg_entry_loc, 150, 600)
        entry_raw = {"entry_points": len(entries), "avg_entry_loc": _r(avg_entry_loc, 1)}
    else:
        entry_score, entry_raw = 0.6, {"entry_points": 0}  # libraries are fine

    # boundaries (package facades) -------------------------------------
    dirs: Dict[str, List[FileMetrics]] = defaultdict(list)
    for f in files:
        if f.language in {"python", "javascript", "typescript"}:
            dirs[posixpath.dirname(f.path)].append(f)
    boundary_dirs = {posixpath.dirname(f.path) for f in all_files if f.is_boundary_file}
    applicable = [d for d, fs in dirs.items() if len(fs) >= 2]
    boundary = None
    if len(applicable) >= 3:
        boundary = sum(1 for d in applicable if d in boundary_dirs) / len(applicable)

    # tests present -----------------------------------------------------
    has_tests = any(f.is_test for f in all_files)

    dim.set({
        "naming_consistency": (naming, 0.25, {
            "file_name_dominance": _r(file_dom, 3), "function_name_dominance": _r(func_dom, 3)}),
        "separation_of_concerns": (soc, 0.25, _r(mixed_frac, 4)),
        "clear_entry_points": (entry_score, 0.20, entry_raw),
        "package_boundaries": (None if boundary is None else lin_up(boundary, 0.2, 0.9), 0.20,
                               _r(boundary, 3)),
        "tests_present": (1.0 if has_tests else 0.4, 0.10, has_tests),
    })
    dim.details = {
        "mixed_concern_files": len(mixed),
        "mixed_concern_examples": sorted(mixed)[:10],
        "entry_point_files": [f.path for f in entries][:10],
        "named_files": file_total,
        "named_functions": func_total,
    }
    return dim


# --------------------------------------------------------------------------
# Overall
# --------------------------------------------------------------------------

def grade(score: float) -> Tuple[str, str]:
    if score >= 85:
        return "A", "Highly modular: small focused units, low coupling, clear boundaries."
    if score >= 72:
        return "B", "Good modularity with some hotspots worth refactoring."
    if score >= 58:
        return "C", "Moderate modularity: noticeable large units or coupling problems."
    if score >= 45:
        return "D", "Weak modularity: significant structural issues."
    return "F", "Poor modularity: monolithic files, tangled dependencies or flat structure."


def compute_scores(
    scored: List[FileMetrics], all_files: List[FileMetrics], graph: GraphInfo
) -> Tuple[Dict[str, Dimension], Dict[str, Any]]:
    dims = {
        "file_level": score_file_level(scored),
        "function_cohesion": score_function_cohesion(scored),
        "coupling": score_coupling(scored, graph),
        "package_structure": score_package_structure(scored, graph),
        "encapsulation": score_encapsulation(scored),
        "code_organization": score_code_organization(scored, graph, all_files),
    }
    available = {k: d for k, d in dims.items() if d.score is not None}
    total_w = sum(WEIGHTS[k] for k in available)
    if total_w <= 0:
        overall = None
    else:
        overall = 100.0 * sum(d.score * WEIGHTS[k] for k, d in available.items()) / total_w
    summary: Dict[str, Any] = {"effective_weights": {
        k: (WEIGHTS[k] / total_w if k in available and total_w else 0.0) for k in dims}}
    if overall is not None:
        g, text = grade(overall)
        summary.update({"score": round(overall, 1), "grade": g, "interpretation": text})
    return dims, summary


# --------------------------------------------------------------------------
# Offenders
# --------------------------------------------------------------------------

def rank_problem_files(
    files: List[FileMetrics], graph: GraphInfo, top_n: int
) -> List[Dict[str, Any]]:
    out = []
    for f in files:
        size_s, defs_s, god = file_health(f)
        scale = FUNC_SCALE.get(f.language, 1.0)
        worst = 1.0
        long_fns = complex_fns = 0
        for fn in f.functions:
            worst = min(worst, function_health(f.language, fn.lines, fn.complexity, fn.params))
            long_fns += fn.lines > 100 * scale
            complex_fns += fn.complexity > 20
        fan_out = graph.fan_out.get(f.path, 0)
        in_cycle = f.path in graph.cyclic_nodes
        severity = (
            0.30 * (1 - size_s) + 0.15 * (1 - defs_s) + 0.20 * (1 - worst)
            + 0.20 * (1 - lin_down(fan_out, 8, 30)) + 0.15 * (0.5 if in_cycle else 0.0)
        )
        if god:
            severity = min(1.0, severity + 0.15)
        reasons = []
        if god:
            reasons.append(f"God file: {f.loc} LOC, {len(f.functions)} functions, {f.classes} classes")
        elif size_s < 0.5:
            reasons.append(f"Large file: {f.loc} LOC")
        if f.max_class_methods >= 30:
            reasons.append(f"Class with {f.max_class_methods} methods")
        if complex_fns:
            reasons.append(f"{complex_fns} function(s) with cyclomatic complexity > 20")
        if long_fns:
            reasons.append(f"{long_fns} function(s) longer than 100 lines")
        if fan_out >= 15:
            reasons.append(f"Depends on {fan_out} other internal files")
        if in_cycle:
            reasons.append("Part of a circular import chain")
        if len(f.infra & {"db", "http", "web"}) >= 2:
            reasons.append("Mixes " + ", ".join(sorted(f.infra & {"db", "http", "web"})) + " concerns")
        if reasons:
            out.append({
                "path": f.path,
                "language": f.language,
                "severity": round(severity, 3),
                "loc": f.loc,
                "functions": len(f.functions),
                "classes": f.classes,
                "fan_out": fan_out,
                "fan_in": graph.fan_in.get(f.path, 0),
                "reasons": reasons,
            })
    out.sort(key=lambda d: (-d["severity"], -d["loc"], d["path"]))
    return out[:top_n]


def rank_problem_functions(files: List[FileMetrics], top_n: int) -> List[Dict[str, Any]]:
    rows = []
    for f in files:
        for fn in f.functions:
            health = function_health(f.language, fn.lines, fn.complexity, fn.params)
            if health < 0.6:
                rows.append({
                    "path": f.path, "function": fn.name, "line": fn.line,
                    "lines": fn.lines, "cyclomatic_complexity": fn.complexity,
                    "parameters": fn.params, "severity": round(1 - health, 3),
                })
    rows.sort(key=lambda d: (-d["severity"], -d["lines"], d["path"], d["function"]))
    return rows[:top_n]
