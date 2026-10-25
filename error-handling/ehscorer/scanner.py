"""Efficient repository walk: skips vendored/build dirs, binaries, generated and huge files."""

from __future__ import annotations

import fnmatch
import os
import re
import zlib
from collections import Counter
from dataclasses import dataclass, field
from typing import List, Optional

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "venv", ".venv", "env",
    "virtualenv", "__pycache__", ".tox", ".nox", ".eggs", "site-packages", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".vscode", "build", "dist", "target", ".gradle",
    ".next", ".nuxt", "coverage", "vendor", "third_party", "third-party", "thirdparty", "Pods",
    ".terraform", "obj", "__pypackages__", "_build", "docs_build", "htmlcov", "migrations",
}
SUPPORTED = {
    ".py": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".java": "java",
    ".go": "go",
}
UNSUPPORTED = {
    ".rb": "Ruby", ".rs": "Rust", ".cs": "C#", ".php": "PHP", ".kt": "Kotlin", ".swift": "Swift",
    ".c": "C", ".cc": "C++", ".cpp": "C++", ".scala": "Scala", ".dart": "Dart", ".ex": "Elixir",
    ".lua": "Lua", ".r": "R", ".m": "Objective-C", ".pl": "Perl", ".sh": "Shell",
}
_SKIP_GLOBS = ["*.min.js", "*.bundle.js", "*.d.ts", "*_pb2.py", "*_pb2_grpc.py", "*.pb.go",
               "*.generated.*", "*_generated.go", "*.gen.go"]
_TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "testing", "e2e", "__mocks__",
              "testdata", "fixtures", "examples", "example", "benchmarks", "docs", "doc"}
_TEST_FILE = re.compile(
    r"(^test_.*\.py$|_test\.py$|^conftest\.py$|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$"
    r"|Tests?\.java$|^Test[A-Z].*\.java$|IT\.java$)"
)


def is_test_path(rel: str) -> bool:
    parts = rel.split("/")
    return any(p.lower() in _TEST_DIRS for p in parts[:-1]) or bool(_TEST_FILE.search(parts[-1]))


@dataclass(frozen=True)
class FileEntry:
    abs_path: str
    rel_path: str
    language: str
    size: int
    is_test: bool


@dataclass
class ScanResult:
    entries: List[FileEntry] = field(default_factory=list)
    skipped: Counter = field(default_factory=Counter)
    unsupported: Counter = field(default_factory=Counter)  # language name -> files
    files_seen: int = 0
    candidates: int = 0
    truncated: bool = False


def scan_repository(root: str, max_files: Optional[int], max_bytes: int) -> ScanResult:
    res = ScanResult()
    cands: List[FileEntry] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in IGNORED_DIRS and not d.startswith(".") and not d.endswith(".egg-info")
            and not os.path.islink(os.path.join(dirpath, d))
        )
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        for name in sorted(filenames):
            res.files_seen += 1
            ext = os.path.splitext(name)[1].lower()
            lang = SUPPORTED.get(ext)
            if lang is None:
                if ext in UNSUPPORTED:
                    res.unsupported[UNSUPPORTED[ext]] += 1
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                res.skipped["symlink"] += 1
                continue
            if any(fnmatch.fnmatch(name, g) for g in _SKIP_GLOBS):
                res.skipped["generated"] += 1
                continue
            try:
                size = os.stat(full).st_size
            except OSError:
                res.skipped["unreadable"] += 1
                continue
            if size == 0:
                continue
            if size > max_bytes:
                res.skipped["too_large"] += 1
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            cands.append(FileEntry(full, rel, lang, size, is_test_path(rel)))
    res.candidates = len(cands)
    if max_files is not None and len(cands) > max_files:
        cands.sort(key=lambda e: (zlib.crc32(e.rel_path.encode()), e.rel_path))
        res.skipped["over_max_files"] += len(cands) - max_files
        cands = sorted(cands[:max_files], key=lambda e: e.rel_path)
        res.truncated = True
    res.entries = cands
    return res
