"""Walk a repository and decide which files deserve analysis."""

from __future__ import annotations

import fnmatch
import logging
import os
import re
import zlib
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .models import AnalysisOptions, FileEntry

log = logging.getLogger(__name__)

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "jspm_packages",
    "venv", ".venv", "virtualenv", "__pycache__", ".tox", ".nox", ".eggs",
    "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea",
    ".vscode", "build", "dist", "target", ".gradle", ".next", ".nuxt", "coverage",
    "vendor", "third_party", "third-party", "thirdparty", "Pods", ".terraform",
    "obj", ".dart_tool", "__pypackages__", "_build",
}

EXTENSIONS = {
    ".py": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".java": "java",
    ".go": "go",
    ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp",
    ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
}

_SKIP_NAME_GLOBS = [
    "*.min.js", "*.min.mjs", "*.bundle.js", "*.d.ts", "*.d.mts", "*.d.cts",
    "*_pb2.py", "*_pb2_grpc.py", "*.pb.go", "*.pb.cc", "*.pb.h", "*.generated.*",
    "*.g.dart",
]

_TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "testing", "e2e", "__mocks__"}
_TEST_FILE_RE = re.compile(
    r"(^test_.*\.py$|_test\.py$|^conftest\.py$|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$"
    r"|Tests?\.java$|^Test[A-Z].*\.java$|_test\.(c|cc|cpp|cxx)$|^test_.*\.(c|cc|cpp|cxx)$)"
)


_BOUNDARY_NAMES = {"__init__.py", "package-info.java", "doc.go"}


def is_test_path(rel_path: str) -> bool:
    parts = rel_path.split("/")
    if any(p.lower() in _TEST_DIRS for p in parts[:-1]):
        return True
    return bool(_TEST_FILE_RE.search(parts[-1]))


@dataclass
class ScanResult:
    entries: List[FileEntry] = field(default_factory=list)
    files_seen: int = 0
    ignored_dirs: int = 0
    skipped: Counter = field(default_factory=Counter)  # reason -> count
    go_modules: Dict[str, str] = field(default_factory=dict)  # dir -> module path
    truncated_by_max_files: bool = False
    total_candidates: int = 0
    warnings: List[str] = field(default_factory=list)


def _read_go_module(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("module"):
                    parts = line.split(None, 1)
                    if len(parts) == 2:
                        return parts[1].strip().strip('"')
                    return None
    except OSError:
        return None
    return None


def scan_repository(root: str, opts: AnalysisOptions) -> ScanResult:
    """Collect analyzable source files under *root* (never follows symlinks)."""
    result = ScanResult()
    root = os.path.abspath(root)
    candidates: List[FileEntry] = []

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        depth = 0 if not rel_dir else rel_dir.count("/") + 1

        kept = []
        for d in sorted(dirnames):
            if d in IGNORED_DIRS or d.startswith(".") or d.endswith(".egg-info"):
                result.ignored_dirs += 1
                continue
            if os.path.islink(os.path.join(dirpath, d)):
                result.skipped["symlink"] += 1
                continue
            kept.append(d)
        if opts.max_depth is not None and depth >= opts.max_depth:
            if kept:
                result.warnings.append(
                    f"--max-depth {opts.max_depth} reached: deeper directories were not analyzed"
                )
            kept = []
        dirnames[:] = kept

        for name in sorted(filenames):
            result.files_seen += 1
            full = os.path.join(dirpath, name)
            if name == "go.mod":
                mod = _read_go_module(full)
                if mod:
                    result.go_modules[rel_dir] = mod
                continue
            ext = os.path.splitext(name)[1].lower()
            language = EXTENSIONS.get(ext)
            if language is None:
                continue
            if os.path.islink(full):
                result.skipped["symlink"] += 1
                continue
            if any(fnmatch.fnmatch(name, g) for g in _SKIP_NAME_GLOBS):
                result.skipped["generated"] += 1
                continue
            try:
                size = os.stat(full).st_size
            except OSError:
                result.skipped["unreadable"] += 1
                continue
            if size == 0 and name not in _BOUNDARY_NAMES and not name.startswith("index."):
                result.skipped["empty"] += 1  # empty __init__.py / index.* still mark a boundary
                continue
            if size > opts.max_file_bytes:
                result.skipped["too_large"] += 1
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            candidates.append(FileEntry(full, rel, language, size, is_test_path(rel)))

    result.total_candidates = len(candidates)
    if opts.max_files is not None and len(candidates) > opts.max_files:
        # Deterministic, hash-based sample so every directory stays represented.
        candidates.sort(key=lambda e: (zlib.crc32(e.rel_path.encode()), e.rel_path))
        dropped = len(candidates) - opts.max_files
        candidates = sorted(candidates[: opts.max_files], key=lambda e: e.rel_path)
        result.truncated_by_max_files = True
        result.skipped["over_max_files"] += dropped
        result.warnings.append(
            f"--max-files {opts.max_files}: analyzed a deterministic sample of "
            f"{opts.max_files} of {result.total_candidates} source files; import edges "
            "to unsampled files are missing, so coupling figures are approximate"
        )
    result.entries = candidates
    return result
