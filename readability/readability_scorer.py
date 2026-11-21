#!/usr/bin/env python3
"""COVAL Readability agent.

Scores how easy a repository's source code is to read (0-100) using static signals:
function length, nesting depth, branching complexity, line length, identifier naming,
and file size. Python is parsed with the standard-library AST; JavaScript, TypeScript,
Java, Go, and similar brace languages use a tolerant line/brace scanner.

Usage:
    python readability_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-kit"))
from coval_agent_kit import coval_ignores, is_ignored  # noqa: E402

VERSION = "1.0.0"
MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 4_000
LONG_LINE = 120
LONG_FUNCTION = 60
DEEP_NESTING = 4
COMPLEX_FUNCTION = 12
LARGE_FILE = 500

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "venv", ".venv", "env", "virtualenv",
    "__pycache__", ".tox", ".nox", ".eggs", "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".idea", ".vscode", "build", "dist", "target", ".gradle", ".next", ".nuxt", "coverage", "vendor",
    "third_party", "third-party", "Pods", ".terraform", "obj", "__pypackages__", "_build", "htmlcov",
    "out", ".output", ".vercel", ".turbo", ".cache", "migrations",
}
BRACE_LANGUAGES = {
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".java": "java", ".go": "go", ".cs": "csharp",
    ".kt": "kotlin", ".swift": "swift", ".php": "php", ".rs": "rust", ".c": "c", ".cc": "cpp", ".cpp": "cpp",
}
SKIP_FILE = re.compile(r"(\.min\.js$|\.bundle\.js$|\.d\.ts$|_pb2(_grpc)?\.py$|\.pb\.go$|\.generated\.|-lock\.|\.lock$)")
ALLOWED_SHORT = {"i", "j", "k", "n", "x", "y", "z", "_", "e", "t", "id", "db", "fn", "cb", "ok", "io", "os", "re", "ui", "el", "ex", "df", "ax", "op", "pk", "ip", "to", "at", "on", "by", "of", "a", "b"}
BRANCH = re.compile(r"\b(if|for|while|case|catch|except|elif|else\s+if)\b|&&|\|\||\?\?|(?<![?.])\?(?![.?:])")
FUNCTION_START = re.compile(
    r"^\s*(export\s+)?(default\s+)?(async\s+)?function\b|\bfunction\s*\w*\s*\(|(\([^()]*\)|\w+)\s*=>\s*\{|^\s*func\b"
    r"|^\s*(public|private|protected|static|final|override|internal|suspend|\s)*[\w<>\[\],\s]+\s+\w+\s*\([^;]*\)\s*(throws\s+[\w.,\s]+)?\{"
    r"|^\s*(async\s+)?\w+\s*\([^)]*\)\s*\{"
)
DECLARED_NAMES = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|\bfunction\s+([A-Za-z_$][\w$]*)|\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)")
CONTROL = re.compile(r"\b(if|for|while|switch|try|catch|else|do|finally|select)\b")
CONTROL_START = re.compile(r"^\s*\}?\s*(if|for|while|switch|catch|else|do|try|finally)\b")
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "else", "do", "try", "function", "new", "typeof"}

WEIGHTS = {
    "function_size": 0.20,
    "nesting": 0.20,
    "complexity": 0.20,
    "line_length": 0.15,
    "naming": 0.15,
    "file_size": 0.10,
}
LABELS = {
    "function_size": "Short, focused functions",
    "nesting": "Shallow nesting",
    "complexity": "Low branching complexity",
    "line_length": "Readable line length",
    "naming": "Descriptive identifiers",
    "file_size": "Manageable file size",
}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def ramp(value: float, zero_at: float, full_at: float) -> float:
    if zero_at == full_at:
        return 100.0 if value <= full_at else 0.0
    return clamp((value - zero_at) / (full_at - zero_at) * 100.0)


def grade(score: float) -> tuple[str, str]:
    if score >= 85:
        return "A", "Very readable: small functions, shallow logic, clear names."
    if score >= 72:
        return "B", "Readable overall with a few dense or oversized hotspots."
    if score >= 58:
        return "C", "Mixed readability: several long or deeply nested functions slow reviewers down."
    if score >= 42:
        return "D", "Hard to read: large functions and tangled branching are common."
    return "F", "Very hard to read: most code needs restructuring before it can be reviewed comfortably."


class PythonMetrics(ast.NodeVisitor):
    BLOCKS = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)
    BRANCHES = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp, ast.comprehension, ast.Assert)

    def __init__(self) -> None:
        self.functions: list[dict] = []
        self.names: list[str] = []

    def visit_FunctionDef(self, node):  # noqa: N802 - ast visitor naming
        self._function(node)

    def visit_AsyncFunctionDef(self, node):  # noqa: N802
        self._function(node)

    def visit_ClassDef(self, node):  # noqa: N802
        self.names.append(node.name)
        self.generic_visit(node)

    def visit_Name(self, node):  # noqa: N802
        if isinstance(node.ctx, ast.Store):
            self.names.append(node.id)

    def visit_arg(self, node):  # noqa: N802
        if node.arg not in {"self", "cls"}:
            self.names.append(node.arg)

    def _function(self, node) -> None:
        self.names.append(node.name)
        length = (getattr(node, "end_lineno", node.lineno) or node.lineno) - node.lineno + 1
        complexity = 1
        for child in ast.walk(node):
            if isinstance(child, self.BRANCHES):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                complexity += len(child.values) - 1
        self.functions.append({"name": node.name, "line": node.lineno, "length": length, "nesting": self._depth(node.body, 0), "complexity": complexity})
        self.generic_visit(node)

    def _depth(self, body, level: int) -> int:
        deepest = level
        for statement in body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(statement, self.BLOCKS):
                inner = [statement.body, getattr(statement, "orelse", []), getattr(statement, "finalbody", [])]
                inner += [handler.body for handler in getattr(statement, "handlers", [])]
                for block in inner:
                    deepest = max(deepest, self._depth(block, level + 1))
        return deepest


def analyze_python(text: str) -> tuple[list[dict], list[str]] | None:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError):
        return None
    visitor = PythonMetrics()
    visitor.visit(tree)
    return visitor.functions, visitor.names


def strip_strings_and_comments(line: str, in_block: bool) -> tuple[str, bool]:
    """Remove string literals and comments so braces inside them are not counted."""
    out = []
    index = 0
    quote = ""
    while index < len(line):
        pair = line[index:index + 2]
        char = line[index]
        if in_block:
            if pair == "*/":
                in_block = False
                index += 2
                continue
            index += 1
            continue
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = ""
            index += 1
            continue
        if pair == "//":
            break
        if pair == "/*":
            in_block = True
            index += 2
            continue
        if char in "\"'`":
            quote = char
            index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out), in_block


def analyze_brace_language(text: str) -> tuple[list[dict], list[str]]:
    """Track a stack of braces tagged as function, control-flow, or other (objects, JSX)."""
    functions: list[dict] = []
    names: list[str] = []
    braces: list[str] = []
    open_functions: list[dict] = []  # each: start line, brace index, max control depth, complexity
    in_block = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line, in_block = strip_strings_and_comments(raw, in_block)
        if not line.strip():
            continue
        for match in DECLARED_NAMES.finditer(line):
            name = next(group for group in match.groups() if group)
            if name not in KEYWORDS:
                names.append(name)
        is_control = bool(CONTROL.search(line))
        starts_function = bool(FUNCTION_START.search(line)) and not CONTROL_START.match(line)
        if open_functions:
            open_functions[-1]["complexity"] += len(BRANCH.findall(line))
        first_open = True
        for char in line:
            if char == "{":
                kind = "other"
                if first_open and starts_function:
                    kind = "function"
                    open_functions.append({"line": number, "index": len(braces), "max": 0, "complexity": 1})
                elif first_open and is_control:
                    kind = "control"
                first_open = False
                braces.append(kind)
                if kind == "control" and open_functions:
                    current = open_functions[-1]
                    depth = sum(1 for item in braces[current["index"] + 1:] if item == "control")
                    current["max"] = max(current["max"], depth)
            elif char == "}" and braces:
                kind = braces.pop()
                if kind == "function" and open_functions and open_functions[-1]["index"] == len(braces):
                    item = open_functions.pop()
                    functions.append({
                        "name": "", "line": item["line"], "length": number - item["line"] + 1,
                        "nesting": item["max"], "complexity": item["complexity"],
                    })
    return functions, names


def iter_files(root: Path):
    count = 0
    ignores = coval_ignores(root)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        prefix = "" if rel_dir == "." else f"{rel_dir}/"
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".") and not is_ignored(f"{prefix}{d}/", ignores))
        for name in sorted(filenames):
            if is_ignored(f"{prefix}{name}", ignores):
                continue
            ext = os.path.splitext(name)[1].lower()
            if (ext != ".py" and ext not in BRACE_LANGUAGES) or SKIP_FILE.search(name):
                continue
            path = Path(dirpath) / name
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            count += 1
            if count > MAX_FILES:
                return
            yield path, ext


def analyze_repository(root: Path) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")
    functions: list[dict] = []
    names: list[str] = []
    files: list[dict] = []
    total_lines = long_lines = 0
    languages: dict[str, int] = {}
    for path, ext in iter_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        lines = [line for line in text.splitlines() if line.strip()]
        if not lines:
            continue
        # Skip minified or generated single-line blobs.
        if len(lines) < 4 and max(len(line) for line in lines) > 400:
            continue
        language = "python" if ext == ".py" else BRACE_LANGUAGES[ext]
        if ext == ".py":
            parsed = analyze_python(text)
            if parsed is None:
                continue
            file_functions, file_names = parsed
        else:
            file_functions, file_names = analyze_brace_language(text)
        languages[language] = languages.get(language, 0) + 1
        total_lines += len(lines)
        long_lines += sum(1 for line in lines if len(line.rstrip()) > LONG_LINE)
        for function in file_functions:
            function["path"] = rel
        functions.extend(file_functions)
        names.extend(file_names)
        files.append({"path": rel, "lines": len(lines)})
    if not files:
        raise ValueError("No supported source files were found to evaluate.")

    function_count = len(functions)
    long_functions = [item for item in functions if item["length"] > LONG_FUNCTION]
    deep_functions = [item for item in functions if item["nesting"] >= DEEP_NESTING]
    complex_functions = [item for item in functions if item["complexity"] > COMPLEX_FUNCTION]
    large_files = [item for item in files if item["lines"] > LARGE_FILE]
    meaningful_names = [name for name in names if name and not name.isupper()]
    unclear_names = [name for name in meaningful_names if len(name.strip("_$")) <= 2 and name.lower() not in ALLOWED_SHORT]

    def share(items: list, total: int) -> float:
        return len(items) / total if total else 0.0

    average_length = sum(item["length"] for item in functions) / function_count if function_count else 0
    categories = {
        "function_size": {
            "score": round(0.6 * ramp(share(long_functions, function_count), 0.35, 0.03) + 0.4 * ramp(average_length, 45, 15), 1),
            "detail": f"{len(long_functions)} of {function_count} functions exceed {LONG_FUNCTION} lines; average length {average_length:.0f} lines.",
        },
        "nesting": {
            "score": round(ramp(share(deep_functions, function_count), 0.25, 0.02), 1),
            "detail": f"{len(deep_functions)} functions nest control flow {DEEP_NESTING}+ levels deep.",
        },
        "complexity": {
            "score": round(ramp(share(complex_functions, function_count), 0.25, 0.02), 1),
            "detail": f"{len(complex_functions)} functions have more than {COMPLEX_FUNCTION} decision points.",
        },
        "line_length": {
            "score": round(ramp(long_lines / max(total_lines, 1), 0.15, 0.01), 1),
            "detail": f"{long_lines:,} of {total_lines:,} lines are longer than {LONG_LINE} characters.",
        },
        "naming": {
            "score": round(ramp(share(unclear_names, len(meaningful_names)), 0.25, 0.02), 1),
            "detail": f"{len(unclear_names)} of {len(meaningful_names)} declared names are one or two characters long.",
        },
        "file_size": {
            "score": round(ramp(share(large_files, len(files)), 0.30, 0.02), 1),
            "detail": f"{len(large_files)} of {len(files)} files exceed {LARGE_FILE} non-blank lines.",
        },
    }
    for key, value in categories.items():
        value["label"] = LABELS[key]
        value["weight"] = WEIGHTS[key]
    score = round(sum(categories[key]["score"] * weight for key, weight in WEIGHTS.items()), 1)
    letter, interpretation = grade(score)
    weakest = min(categories.items(), key=lambda item: item[1]["score"])
    hotspots = sorted(functions, key=lambda item: (item["complexity"] * 2 + item["length"] / 10 + item["nesting"] * 3), reverse=True)[:10]
    summary = f"Analyzed {function_count:,} functions in {len(files):,} files. Weakest area: {weakest[1]['label'].lower()} ({weakest[1]['score']:.0f}/100)."
    return {
        "tool": "readability",
        "version": VERSION,
        "generated_at": now(),
        "repository": root.name,
        "final_score": {"score": score, "grade": letter, "interpretation": interpretation},
        "summary": summary,
        "categories": categories,
        "stats": {"files": len(files), "functions": function_count, "lines": total_lines, "languages": languages},
        "hotspots": [{"path": item["path"], "line": item["line"], "name": item.get("name") or "", "length": item["length"], "nesting": item["nesting"], "complexity": item["complexity"]} for item in hotspots],
        "largest_files": sorted(large_files, key=lambda item: item["lines"], reverse=True)[:10],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repo", help="Path to a local checkout (never modified).")
    parser.add_argument("-o", "--output", default="readability_report.json", help="Output JSON path.")
    parser.add_argument("-q", "--quiet", action="store_true", help="Only print errors.")
    args = parser.parse_args(argv)
    try:
        report = analyze_repository(Path(args.repo))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 4
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not args.quiet:
        final = report["final_score"]
        print(f"Readability: {final['score']}/100 ({final['grade']}) — {report['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
