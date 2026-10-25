"""Internal dependency graph: resolve imports to files, find cycles and depth."""

from __future__ import annotations

import posixpath
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .models import FileMetrics, ImportRef

_PY_SOURCE_ROOTS = {"src", "lib", "source", "python", "app"}
_JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
_JS_BUILTINS = {
    "fs", "path", "os", "http", "https", "net", "url", "util", "events", "stream", "crypto",
    "child_process", "assert", "buffer", "zlib", "readline", "process", "tls", "dns", "cluster",
    "worker_threads", "querystring", "string_decoder", "timers", "vm", "v8", "module",
}
_STD_PY = getattr(sys, "stdlib_module_names", frozenset())
_C_STD_CPP = {
    "algorithm", "array", "atomic", "chrono", "cmath", "condition_variable", "deque", "exception",
    "fstream", "functional", "iostream", "iomanip", "list", "map", "memory", "mutex", "numeric",
    "optional", "queue", "set", "sstream", "stack", "string", "thread", "tuple", "unordered_map",
    "unordered_set", "utility", "variant", "vector",
}
_GO_CAP = 12  # max files a Go package import fans out to
_JAVA_WILDCARD_CAP = 25


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------

@dataclass
class Resolution:
    internal: Set[str] = field(default_factory=set)
    external_roots: Set[str] = field(default_factory=set)


class ImportResolver:
    """Maps import statements onto files of the repository being analyzed."""

    def __init__(self, files: List[FileMetrics], go_modules: Dict[str, str]) -> None:
        self.paths: Set[str] = {f.path for f in files}
        self.by_dir: Dict[str, List[str]] = defaultdict(list)
        for f in files:
            self.by_dir[posixpath.dirname(f.path)].append(f.path)
        self._build_python(files)
        self._build_java(files)
        self._build_c()
        self.go_modules = go_modules  # dir -> module path

    # -- index construction ------------------------------------------------
    def _build_python(self, files: List[FileMetrics]) -> None:
        py = [f.path for f in files if f.language == "python"]
        py_set = set(py)
        self.py_rel: Dict[str, str] = {}
        self.py_abs: Dict[str, str] = {}

        def put(index: Dict[str, str], key: str, path: str) -> None:
            if not key:
                return
            cur = index.get(key)
            if cur is None or (len(path), path) < (len(cur), cur):
                index[key] = path

        for path in py:
            parts = path[:-3].split("/")
            is_pkg = parts[-1] == "__init__"
            if is_pkg:
                parts = parts[:-1]
            put(self.py_rel, ".".join(parts), path)
            put(self.py_abs, ".".join(parts), path)
            if len(parts) > 1 and parts[0] in _PY_SOURCE_ROOTS:
                put(self.py_abs, ".".join(parts[1:]), path)
            # canonical name relative to the nearest non-package ancestor
            d = posixpath.dirname(path)
            k = len(parts) - (0 if is_pkg else 1)  # number of directory parts
            dir_parts = parts[:k]
            start = len(dir_parts)
            while start > 0 and posixpath.join(*dir_parts[:start], "__init__.py") in py_set:
                start -= 1
            canon = parts[start:]
            put(self.py_abs, ".".join(canon), path)
            del d

    def _build_java(self, files: List[FileMetrics]) -> None:
        self.java_fqcn: Dict[str, str] = {}
        self.java_pkg: Dict[str, List[str]] = defaultdict(list)
        for f in files:
            if f.language != "java":
                continue
            stem = posixpath.splitext(posixpath.basename(f.path))[0]
            if f.package:
                self.java_fqcn[f"{f.package}.{stem}"] = f.path
                self.java_pkg[f.package].append(f.path)

    def _build_c(self) -> None:
        self.c_by_base: Dict[str, List[str]] = defaultdict(list)
        for p in self.paths:
            if p.endswith((".h", ".hpp", ".hh", ".hxx", ".c", ".cc", ".cpp", ".cxx", ".c++")):
                self.c_by_base[posixpath.basename(p)].append(p)

    # -- per language ------------------------------------------------------
    def resolve(self, fm: FileMetrics) -> Resolution:
        res = Resolution()
        handler = {
            "python": self._python, "javascript": self._js, "typescript": self._js,
            "java": self._java, "go": self._go, "c": self._c, "cpp": self._c,
        }.get(fm.language)
        if handler is None:
            return res
        for ref in fm.imports:
            handler(fm, ref, res)
        res.internal.discard(fm.path)
        return res

    def _python(self, fm: FileMetrics, ref: ImportRef, res: Resolution) -> None:
        if ref.level:
            parts = posixpath.dirname(fm.path).split("/") if "/" in fm.path else []
            up = ref.level - 1
            if up > len(parts):
                return
            base = parts[: len(parts) - up] if up else parts
            prefix = ".".join(base + ([ref.spec] if ref.spec else []))
            hit = False
            for name in ref.names:
                target = self.py_rel.get(f"{prefix}.{name}" if prefix else name)
                if target:
                    res.internal.add(target)
                    hit = True
            if not hit and prefix:
                target = self.py_rel.get(prefix)
                if target:
                    res.internal.add(target)
            return

        spec = ref.spec
        if not spec:
            return
        hit = False
        for name in ref.names:
            target = self.py_abs.get(f"{spec}.{name}")
            if target:
                res.internal.add(target)
                hit = True
        if hit:
            return
        parts = spec.split(".")
        for n in range(len(parts), 0, -1):
            target = self.py_abs.get(".".join(parts[:n]))
            if target:
                res.internal.add(target)
                return
        root = parts[0]
        if root not in _STD_PY:
            res.external_roots.add(root)

    def _js_candidates(self, base: str) -> List[str]:
        stripped = base
        for ext in (".js", ".jsx", ".mjs", ".cjs"):
            if base.endswith(ext):
                stripped = base[: -len(ext)]
                break
        out = [base] if base in self.paths else []
        for root in {base, stripped}:
            out += [root + e for e in _JS_EXTS]
            out += [f"{root}/index{e}" for e in _JS_EXTS]
        return out

    def _js(self, fm: FileMetrics, ref: ImportRef, res: Resolution) -> None:
        spec = ref.spec
        if spec.startswith("node:"):
            return
        bases: List[str] = []
        if spec.startswith("."):
            bases.append(posixpath.normpath(posixpath.join(posixpath.dirname(fm.path), spec)))
        elif spec.startswith(("@/", "~/")):
            bases += [f"src/{spec[2:]}", spec[2:]]
        elif spec.split("/")[0] in {"src", "app", "lib"}:
            bases.append(spec)
        for base in bases:
            for cand in self._js_candidates(base):
                if cand in self.paths:
                    res.internal.add(cand)
                    return
        if bases and spec.startswith("."):
            return  # unresolved relative import (asset, generated file, ...)
        root = spec.split("/")[0] if not spec.startswith("@") else "/".join(spec.split("/")[:2])
        if root and root not in _JS_BUILTINS:
            res.external_roots.add(root)

    def _java(self, fm: FileMetrics, ref: ImportRef, res: Resolution) -> None:
        spec = ref.spec
        if spec.endswith(".*"):
            pkg = spec[:-2]
            for p in self.java_pkg.get(pkg, [])[:_JAVA_WILDCARD_CAP]:
                res.internal.add(p)
            return
        parts = spec.split(".")
        for n in range(len(parts), 1, -1):  # static imports: trim member names
            target = self.java_fqcn.get(".".join(parts[:n]))
            if target:
                res.internal.add(target)
                return
        if not spec.startswith(("java.", "javax.", "jakarta.")):
            res.external_roots.add(".".join(parts[:2]))

    def _go(self, fm: FileMetrics, ref: ImportRef, res: Resolution) -> None:
        spec = ref.spec
        target_dir: Optional[str] = None
        best = -1
        for mod_dir, mod_path in self.go_modules.items():
            if spec == mod_path or spec.startswith(mod_path + "/"):
                rest = spec[len(mod_path):].lstrip("/")
                cand = posixpath.normpath(posixpath.join(mod_dir, rest)) if (mod_dir or rest) else ""
                cand = "" if cand == "." else cand
                if len(mod_path) > best and cand in self.by_dir:
                    target_dir, best = cand, len(mod_path)
        if target_dir is None and "." in spec.split("/")[0]:
            segs = spec.split("/")  # no go.mod: match the longest path suffix
            for k in range(len(segs)):
                cand = "/".join(segs[k:])
                if cand in self.by_dir:
                    target_dir = cand
                    break
        if target_dir is None:
            if "." in spec.split("/")[0]:
                res.external_roots.add("/".join(spec.split("/")[:3]))
            return
        files = [p for p in self.by_dir[target_dir] if p.endswith(".go") and not p.endswith("_test.go")]
        for p in sorted(files)[:_GO_CAP]:
            res.internal.add(p)

    def _c(self, fm: FileMetrics, ref: ImportRef, res: Resolution) -> None:
        spec = ref.spec
        system = ref.level == 1
        if not system:
            local = posixpath.normpath(posixpath.join(posixpath.dirname(fm.path), spec))
            if local in self.paths:
                res.internal.add(local)
                return
        base = posixpath.basename(spec)
        if system and (base in _C_STD_CPP or "/" not in spec):
            if base in _C_STD_CPP or not self.c_by_base.get(base):
                return
        cands = [p for p in self.c_by_base.get(base, []) if p == spec or p.endswith("/" + spec)]
        if not cands:
            return
        here = posixpath.dirname(fm.path)

        def closeness(p: str) -> Tuple[int, str]:
            common = len(posixpath.commonpath([here or ".", posixpath.dirname(p) or "."]).split("/"))
            return (-common, p)

        res.internal.add(sorted(cands, key=closeness)[0])


# --------------------------------------------------------------------------
# Graph analysis
# --------------------------------------------------------------------------

@dataclass
class GraphInfo:
    nodes: int = 0
    edges: int = 0
    adj: Dict[str, Set[str]] = field(default_factory=dict)
    fan_out: Dict[str, int] = field(default_factory=dict)
    fan_in: Dict[str, int] = field(default_factory=dict)
    sccs: List[List[str]] = field(default_factory=list)  # only size > 1, largest first
    cyclic_nodes: Set[str] = field(default_factory=set)
    depth: int = 0
    external_deps: Dict[str, int] = field(default_factory=dict)
    import_refs: int = 0


def _tarjan(adj: List[List[int]]) -> List[List[int]]:
    """Iterative Tarjan SCC; components come out in reverse topological order."""
    n = len(adj)
    index = [-1] * n
    low = [0] * n
    on_stack = [False] * n
    stack: List[int] = []
    result: List[List[int]] = []
    counter = 0
    for root in range(n):
        if index[root] != -1:
            continue
        work: List[Tuple[int, int]] = [(root, 0)]
        while work:
            v, pi = work.pop()
            if pi == 0:
                index[v] = low[v] = counter
                counter += 1
                stack.append(v)
                on_stack[v] = True
            descended = False
            nbrs = adj[v]
            for i in range(pi, len(nbrs)):
                w = nbrs[i]
                if index[w] == -1:
                    work.append((v, i + 1))
                    work.append((w, 0))
                    descended = True
                    break
                if on_stack[w]:
                    low[v] = min(low[v], index[w])
            if descended:
                continue
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == v:
                        break
                result.append(comp)
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[v])
    return result


def build_graph(
    resolver_files: List[FileMetrics],
    scored: List[FileMetrics],
    go_modules: Dict[str, str],
) -> GraphInfo:
    """Build the dependency graph over *scored* files.

    Imports are resolved against *resolver_files* (which may also contain test
    files) but edges are only kept between scored files.
    """
    resolver = ImportResolver(resolver_files, go_modules)
    node_set = {f.path for f in scored}
    info = GraphInfo(nodes=len(scored))
    adj: Dict[str, Set[str]] = {f.path: set() for f in scored}
    for fm in scored:
        res = resolver.resolve(fm)
        info.import_refs += len(fm.imports)
        adj[fm.path] = {t for t in res.internal if t in node_set}
        info.external_deps[fm.path] = len(res.external_roots)
    info.adj = adj
    info.edges = sum(len(v) for v in adj.values())
    info.fan_out = {p: len(v) for p, v in adj.items()}
    fan_in: Dict[str, int] = defaultdict(int)
    for targets in adj.values():
        for t in targets:
            fan_in[t] += 1
    info.fan_in = {p: fan_in.get(p, 0) for p in adj}

    names = sorted(adj)
    idx = {p: i for i, p in enumerate(names)}
    int_adj = [sorted(idx[t] for t in adj[p]) for p in names]
    comps = _tarjan(int_adj)

    comp_id = [0] * len(names)
    depth_of: List[int] = []
    for ci, comp in enumerate(comps):  # successors are always emitted earlier
        for v in comp:
            comp_id[v] = ci
        best = 0
        for v in comp:
            for w in int_adj[v]:
                if comp_id[w] != ci:
                    best = max(best, depth_of[comp_id[w]])
        depth_of.append(best + 1)
    info.depth = max(depth_of, default=0)

    cyc = [sorted(names[v] for v in comp) for comp in comps if len(comp) > 1]
    cyc.sort(key=lambda c: (-len(c), c))
    info.sccs = cyc
    info.cyclic_nodes = {p for comp in cyc for p in comp}
    return info
