"""Shared result containers and the per-handler classification used by every language."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

MAX_FINDINGS_PER_KIND_PER_FILE = 25


@dataclass
class Finding:
    """One concrete place worth showing to the user."""

    kind: str
    path: str
    line: int
    note: str = ""


@dataclass
class FileResult:
    """Counters and findings for one analyzed file (all counters are additive)."""

    path: str
    language: str
    is_test: bool = False
    loc: int = 0
    parse_mode: str = "none"  # ast | heuristic | fallback | failed
    skipped: Optional[str] = None
    error: Optional[str] = None
    c: Dict[str, float] = field(default_factory=lambda: defaultdict(float))
    findings: List[Finding] = field(default_factory=list)
    classes: List[Tuple[str, Tuple[str, ...]]] = field(default_factory=list)
    used_names: Set[str] = field(default_factory=set)  # exception names raised or caught
    _kind_counts: Dict[str, int] = field(default_factory=dict, repr=False)

    def inc(self, key: str, n: float = 1) -> None:
        self.c[key] = self.c.get(key, 0) + n

    def add(self, kind: str, line: int, note: str = "") -> None:
        n = self._kind_counts.get(kind, 0)
        self._kind_counts[kind] = n + 1
        if n < MAX_FINDINGS_PER_KIND_PER_FILE:
            self.findings.append(Finding(kind, self.path, line, note))
        self.inc("f." + kind)  # exact total, even when examples are capped


# Exception names that are fine to swallow silently in the situations they occur in.
IDIOMATIC_SWALLOW = {
    "ImportError", "ModuleNotFoundError", "StopIteration", "StopAsyncIteration",
    "CancelledError", "GeneratorExit", "ProcessLookupError", "FileNotFoundError",
}


def record_handler(
    res: FileResult,
    kind: str,
    *,
    line: int,
    raised: bool = False,
    reraised: bool = False,
    new_raises: int = 0,
    chained: int = 0,
    logged: bool = False,
    printed: bool = False,
    uses_exc: bool = False,
    exits: bool = False,
    trivial: bool = False,
    idiomatic: bool = False,
    swallow_kind: str = "swallowed_exception",
    unchained_kind: str = "raise_without_cause",
    label: str = "",
) -> None:
    """Score one error handler.

    *kind* is one of ``bare`` (catches everything, no type), ``broad`` (catches
    Exception/Throwable), ``untyped`` (language has no typed catch, e.g. JS) and
    ``specific``. Two scores are accumulated per handler, both in 0..1:

    * ``h_spec``  - how precisely the handler targets failures
    * ``h_qual``  - what the handler does with the error
    """
    strong = raised or logged
    res.inc("handlers")
    res.inc("h_" + kind)

    if kind == "specific":
        spec = 1.0
    elif kind == "untyped":
        spec = 0.8 if strong else 0.4
    elif kind == "broad":
        spec = 0.6 if strong else 0.25
    else:  # bare
        spec = 0.3 if reraised else 0.0

    if strong:
        qual = 1.0
    elif printed or uses_exc or exits:
        qual = 0.7
    elif trivial:
        qual = 0.8 if idiomatic else (0.25 if kind in ("specific", "untyped") else 0.0)
    else:
        qual = 0.6 if kind in ("specific", "untyped") else 0.4
    res.inc("h_spec_sum", spec)
    res.inc("h_qual_sum", qual)

    if logged:
        res.inc("h_log")
    if raised:
        res.inc("h_propagate")
    silent = trivial and not idiomatic and not strong
    if silent:
        res.inc("h_silent")
    if idiomatic and trivial:
        res.inc("h_idiomatic")
    if new_raises:
        res.inc("h_new_raise", new_raises)
        res.inc("h_new_chained", chained)

    where = f" ({label})" if label else ""
    if kind == "bare":
        res.add("bare_except", line, "catches every exception, including KeyboardInterrupt/SystemExit"
                + ("; body is empty" if trivial else ""))
    if silent:
        res.add(swallow_kind, line, "error is silently discarded" + where)
    elif kind in ("broad", "bare") and not strong and not printed and not exits:
        res.add("broad_except_no_handling", line,
                "catches a broad exception but neither logs nor re-raises" + where)
    if new_raises > chained:
        res.add(unchained_kind, line, "new exception raised without preserving the original cause")
