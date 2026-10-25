"""Plain data containers shared across the analyzer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple


@dataclass(frozen=True)
class FileEntry:
    """A source file discovered by the scanner (not yet analyzed)."""

    abs_path: str
    rel_path: str  # POSIX-style, relative to the repository root
    language: str
    size: int
    is_test: bool = False


@dataclass
class ImportRef:
    """One import / include / require statement, language-neutral."""

    spec: str
    level: int = 0  # Python relative-import level (number of leading dots)
    names: Tuple[str, ...] = ()  # Python ``from x import a, b`` names


@dataclass
class FunctionInfo:
    """Metrics for a single function or method."""

    name: str
    lines: int
    complexity: int
    params: int
    line: int = 0
    private: bool = False


@dataclass
class FileMetrics:
    """Everything the scorer needs to know about one analyzed file."""

    path: str
    language: str
    is_test: bool = False
    size: int = 0
    total_lines: int = 0
    loc: int = 0  # non-blank, non-comment lines
    functions: List[FunctionInfo] = field(default_factory=list)
    classes: int = 0
    interface_sizes: List[int] = field(default_factory=list)
    max_class_methods: int = 0
    imports: List[ImportRef] = field(default_factory=list)
    public_members: int = 0
    private_members: int = 0
    is_entry_point: bool = False
    is_boundary_file: bool = False  # __init__.py, index.js, package-info.java, ...
    package: str = ""  # declared package (Java / Go)
    infra: Set[str] = field(default_factory=set)  # {"db", "http", "web"}
    parse_mode: str = "none"  # ast | heuristic | fallback | failed
    skipped: Optional[str] = None  # reason, if the file was not analyzed
    error: Optional[str] = None


@dataclass
class AnalysisOptions:
    """User-tunable knobs (mostly populated from the CLI)."""

    max_files: Optional[int] = None
    max_depth: Optional[int] = None
    max_file_bytes: int = 1_000_000
    file_timeout: float = 10.0
    clone_timeout: float = 900.0
    branch: Optional[str] = None
    include_tests: bool = False
    jobs: int = 1
    top_n: int = 15
    show_progress: bool = True
