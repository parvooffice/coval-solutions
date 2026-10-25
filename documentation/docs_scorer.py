#!/usr/bin/env python3
"""
Documentation Quality Scorer for GitHub Repositories

A CLI tool that clones a GitHub repository, analyzes its documentation quality,
and outputs a weighted score with summary to a JSON file.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Configuration / Weights
# ---------------------------------------------------------------------------

WEIGHTS = {
    "readme": 0.30,
    "docstrings": 0.25,
    "comments": 0.15,
    "docs_folder": 0.15,
    "supporting_docs": 0.15,
}

# Common documentation file names (case-insensitive matching)
SUPPORTING_DOC_PATTERNS = [
    r"^contributing\.md$",
    r"^changelog\.md$",
    r"^history\.md$",
    r"^code_of_conduct\.md$",
    r"^security\.md$",
    r"^license(\.md|\.txt)?$",
    r"^copying$",
    r"^authors(\.md)?$",
    r"^credits(\.md)?$",
    r"^faq\.md$",
    r"^todo\.md$",
]

# Expected README sections (heuristics)
README_SECTIONS = [
    r"(?i)#+\s*install(ation)?",
    r"(?i)#+\s*(usage|getting\s+started|quick\s*start)",
    r"(?i)#+\s*(api|reference|documentation)",
    r"(?i)#+\s*(contribut(ing|ion))",
    r"(?i)#+\s*(license|licensing)",
    r"(?i)#+\s*(example|examples|demo)",
    r"(?i)#+\s*(feature|features)",
    r"(?i)#+\s*(requirement|dependencies|prerequisites)",
]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class FileStats:
    path: str
    language: str
    lines: int = 0
    comment_lines: int = 0
    docstring_lines: int = 0
    has_module_docstring: bool = False
    functions_with_docstring: int = 0
    total_functions: int = 0
    classes_with_docstring: int = 0
    total_classes: int = 0


@dataclass
class AnalysisResult:
    repo_url: str
    repo_name: str
    analyzed_at: str
    score: float
    max_score: float = 100.0
    breakdown: Dict[str, float] = field(default_factory=dict)
    summary: str = ""
    highlights: List[str] = field(default_factory=list)
    issues: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_github_url(url: str) -> bool:
    """Basic validation that the URL looks like a GitHub repository."""
    parsed = urlparse(url)
    if parsed.netloc not in ("github.com", "www.github.com"):
        return False
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    return len(parts) >= 2


def normalize_github_url(url: str) -> str:
    """Ensure the URL ends without .git and is clean."""
    url = url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    return url


def clone_repo(url: str, dest: Path) -> Path:
    """Clone the repository shallowly into dest. Returns path to the clone."""
    url = normalize_github_url(url)
    if not url.endswith(".git"):
        url = url + ".git"

    cmd = [
        "git", "clone",
        "--depth", "1",
        "--single-branch",
        "--quiet",
        url,
        str(dest),
    ]
    try:
        subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Failed to clone repository: {e.stderr.strip() or e.stdout.strip()}"
        ) from e
    except subprocess.TimeoutExpired:
        raise RuntimeError("Clone timed out after 120 seconds") from None
    except FileNotFoundError:
        raise RuntimeError("git is not installed or not found in PATH") from None

    return dest


def detect_language(path: Path) -> str:
    """Simple extension-based language detection."""
    ext = path.suffix.lower()
    mapping = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".jsx": "javascript",
        ".tsx": "typescript",
        ".java": "java",
        ".go": "go",
        ".rs": "rust",
        ".rb": "ruby",
        ".php": "php",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".hpp": "cpp",
        ".cs": "csharp",
        ".swift": "swift",
        ".kt": "kotlin",
        ".scala": "scala",
        ".sh": "shell",
        ".bash": "shell",
        ".md": "markdown",
        ".rst": "restructuredtext",
        ".txt": "text",
    }
    return mapping.get(ext, "other")


def count_comment_lines(content: str, language: str) -> int:
    """Rough count of comment lines for common languages."""
    lines = content.splitlines()
    count = 0

    if language == "python":
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("#"):
                count += 1
    elif language in ("javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust", "swift", "kotlin", "scala"):
        in_block = False
        for line in lines:
            stripped = line.strip()
            if in_block:
                count += 1
                if "*/" in stripped:
                    in_block = False
                continue
            if stripped.startswith("//"):
                count += 1
            elif "/*" in stripped:
                count += 1
                if "*/" not in stripped:
                    in_block = True
    elif language == "shell":
        for line in lines:
            if line.strip().startswith("#"):
                count += 1
    elif language == "ruby":
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("#"):
                count += 1
    # Other languages left at 0 for simplicity

    return count


def analyze_python_file(path: Path, content: str) -> FileStats:
    """Parse a Python file with the AST to extract docstring coverage."""
    stats = FileStats(path=str(path), language="python")
    lines = content.splitlines()
    stats.lines = len(lines)
    stats.comment_lines = count_comment_lines(content, "python")

    try:
        tree = ast.parse(content)
    except SyntaxError:
        return stats

    # Module docstring
    if tree.body and isinstance(tree.body[0], ast.Expr):
        value = tree.body[0].value
        doc_str = None
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            doc_str = value.value
        elif hasattr(ast, "Str") and isinstance(value, getattr(ast, "Str")):  # Python < 3.8
            doc_str = value.s
        if doc_str is not None:
            stats.has_module_docstring = True
            stats.docstring_lines += len(doc_str.splitlines())

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            stats.total_functions += 1
            if ast.get_docstring(node):
                stats.functions_with_docstring += 1
                doc = ast.get_docstring(node) or ""
                stats.docstring_lines += len(doc.splitlines())
        elif isinstance(node, ast.ClassDef):
            stats.total_classes += 1
            if ast.get_docstring(node):
                stats.classes_with_docstring += 1
                doc = ast.get_docstring(node) or ""
                stats.docstring_lines += len(doc.splitlines())

    return stats


def analyze_generic_file(path: Path, content: str, language: str) -> FileStats:
    """Fallback analysis for non-Python source files."""
    stats = FileStats(path=str(path), language=language)
    stats.lines = len(content.splitlines())
    stats.comment_lines = count_comment_lines(content, language)
    return stats


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def find_readme(root: Path) -> Optional[Path]:
    """Locate the primary README file."""
    candidates = [
        "README.md", "README.rst", "README.txt", "README",
        "Readme.md", "readme.md", "README.MD",
    ]
    for name in candidates:
        p = root / name
        if p.is_file():
            return p
    # Fallback: any README*
    for p in root.iterdir():
        if p.is_file() and p.name.lower().startswith("readme"):
            return p
    return None


def score_readme(readme_path: Optional[Path], root: Path) -> Tuple[float, Dict[str, Any], List[str], List[str]]:
    """Score the README on presence, length, and section coverage."""
    highlights: List[str] = []
    issues: List[str] = []
    details: Dict[str, Any] = {}

    if not readme_path:
        issues.append("No README file found at repository root.")
        return 0.0, details, highlights, issues

    try:
        content = readme_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        issues.append(f"Could not read README: {e}")
        return 0.0, details, highlights, issues

    length = len(content)
    details["path"] = str(readme_path.relative_to(root))
    details["length_chars"] = length
    details["length_lines"] = len(content.splitlines())

    # Base presence score
    score = 40.0  # just for existing

    # Length bonus (up to 30 points)
    if length > 3000:
        score += 30
        highlights.append(f"README is substantial ({length} characters).")
    elif length > 1500:
        score += 22
        highlights.append(f"README has good length ({length} characters).")
    elif length > 600:
        score += 12
    elif length > 200:
        score += 5
    else:
        issues.append("README is very short; consider expanding it with usage examples and installation instructions.")

    # Section coverage (up to 30 points)
    found_sections = []
    for pattern in README_SECTIONS:
        if re.search(pattern, content):
            found_sections.append(pattern)
    section_score = min(30.0, len(found_sections) * 5.0)
    score += section_score
    details["sections_found"] = len(found_sections)
    details["expected_sections"] = len(README_SECTIONS)

    if len(found_sections) >= 5:
        highlights.append(f"README covers many useful sections ({len(found_sections)} detected).")
    elif len(found_sections) <= 1:
        issues.append("README appears to lack common sections (Installation, Usage, Contributing, License, etc.).")

    # Badges / shields (small bonus)
    if re.search(r"!\[.*\]\(https?://.*shields\.io", content) or "badge" in content.lower():
        score = min(100.0, score + 5)
        highlights.append("README includes status badges.")

    return min(100.0, score), details, highlights, issues


def score_docstrings(file_stats: List[FileStats]) -> Tuple[float, Dict[str, Any], List[str], List[str]]:
    """Score based on docstring coverage in Python files."""
    highlights: List[str] = []
    issues: List[str] = []
    details: Dict[str, Any] = {}

    py_files = [s for s in file_stats if s.language == "python"]
    if not py_files:
        details["python_files"] = 0
        # Neutral score if no Python – documentation quality still assessed elsewhere
        return 70.0, details, highlights, ["No Python source files found; docstring score is neutral."]

    total_funcs = sum(s.total_functions for s in py_files)
    documented_funcs = sum(s.functions_with_docstring for s in py_files)
    total_classes = sum(s.total_classes for s in py_files)
    documented_classes = sum(s.classes_with_docstring for s in py_files)
    modules_with_doc = sum(1 for s in py_files if s.has_module_docstring)
    total_modules = len(py_files)

    details["python_files"] = total_modules
    details["functions_total"] = total_funcs
    details["functions_documented"] = documented_funcs
    details["classes_total"] = total_classes
    details["classes_documented"] = documented_classes
    details["modules_with_docstring"] = modules_with_doc

    # Coverage ratios
    func_cov = (documented_funcs / total_funcs) if total_funcs else 1.0
    class_cov = (documented_classes / total_classes) if total_classes else 1.0
    mod_cov = (modules_with_doc / total_modules) if total_modules else 0.0

    # Weighted internal score
    score = (func_cov * 50) + (class_cov * 30) + (mod_cov * 20)
    score = round(score, 1)

    if score >= 80:
        highlights.append(
            f"Strong docstring coverage: {documented_funcs}/{total_funcs} functions, "
            f"{documented_classes}/{total_classes} classes, {modules_with_doc}/{total_modules} modules."
        )
    elif score >= 50:
        highlights.append(
            f"Moderate docstring coverage ({score:.0f}%). Consider documenting public APIs more thoroughly."
        )
    else:
        issues.append(
            f"Low docstring coverage ({score:.0f}%): only {documented_funcs}/{total_funcs} functions "
            f"and {documented_classes}/{total_classes} classes have docstrings."
        )

    if total_modules > 5 and mod_cov < 0.3:
        issues.append("Many Python modules lack a top-level module docstring.")

    return score, details, highlights, issues


def score_comments(file_stats: List[FileStats]) -> Tuple[float, Dict[str, Any], List[str], List[str]]:
    """Score based on comment density in source files."""
    highlights: List[str] = []
    issues: List[str] = []
    details: Dict[str, Any] = {}

    source_files = [s for s in file_stats if s.language not in ("markdown", "restructuredtext", "text", "other")]
    if not source_files:
        return 60.0, details, highlights, ["No source code files found for comment analysis."]

    total_lines = sum(s.lines for s in source_files)
    total_comments = sum(s.comment_lines for s in source_files)
    ratio = (total_comments / total_lines) if total_lines else 0.0

    details["source_files"] = len(source_files)
    details["total_lines"] = total_lines
    details["comment_lines"] = total_comments
    details["comment_ratio"] = round(ratio, 4)

    # Heuristic: 5–15% is healthy; too low or extremely high both suboptimal
    if 0.05 <= ratio <= 0.18:
        score = 90.0
        highlights.append(f"Healthy comment density ({ratio*100:.1f}% of source lines).")
    elif 0.03 <= ratio < 0.05 or 0.18 < ratio <= 0.25:
        score = 70.0
    elif ratio < 0.03:
        score = 40.0
        issues.append(f"Very low comment density ({ratio*100:.1f}%). Consider adding explanatory comments for complex logic.")
    else:
        score = 55.0
        issues.append(f"High comment density ({ratio*100:.1f}%). Some comments may be redundant; prefer clear code + selective comments.")

    return score, details, highlights, issues


def score_docs_folder(root: Path) -> Tuple[float, Dict[str, Any], List[str], List[str]]:
    """Score presence and richness of a dedicated docs/ directory."""
    highlights: List[str] = []
    issues: List[str] = []
    details: Dict[str, Any] = {}

    candidates = ["docs", "doc", "documentation", "Docs", "DOC"]
    docs_dir = None
    for name in candidates:
        p = root / name
        if p.is_dir():
            docs_dir = p
            break

    if not docs_dir:
        # Also accept Sphinx-style or mkdocs at root
        if (root / "mkdocs.yml").exists() or (root / "conf.py").exists():
            details["type"] = "config_at_root"
            highlights.append("Documentation tooling config found at repository root (mkdocs/Sphinx).")
            return 75.0, details, highlights, issues
        issues.append("No dedicated docs/ directory found.")
        return 20.0, details, highlights, issues

    md_files = list(docs_dir.rglob("*.md")) + list(docs_dir.rglob("*.rst"))
    details["path"] = str(docs_dir.relative_to(root))
    details["doc_files"] = len(md_files)

    if len(md_files) >= 5:
        score = 95.0
        highlights.append(f"Rich documentation folder with {len(md_files)} markdown/RST files.")
    elif len(md_files) >= 2:
        score = 75.0
        highlights.append(f"Documentation folder present with {len(md_files)} files.")
    elif len(md_files) == 1:
        score = 55.0
    else:
        score = 35.0
        issues.append("docs/ directory exists but contains almost no content.")

    # Bonus for common structure
    if any(f.name.lower() in ("index.md", "index.rst", "readme.md") for f in md_files):
        score = min(100.0, score + 5)

    return score, details, highlights, issues


def score_supporting_docs(root: Path) -> Tuple[float, Dict[str, Any], List[str], List[str]]:
    """Score presence of CONTRIBUTING, LICENSE, CHANGELOG, etc."""
    highlights: List[str] = []
    issues: List[str] = []
    details: Dict[str, Any] = {"found": []}

    found = []
    for path in root.iterdir():
        if not path.is_file():
            continue
        name = path.name.lower()
        for pattern in SUPPORTING_DOC_PATTERNS:
            if re.match(pattern, name):
                found.append(path.name)
                break

    details["found"] = found
    count = len(found)

    if count >= 4:
        score = 95.0
        highlights.append(f"Excellent supporting documentation: {', '.join(found)}.")
    elif count >= 2:
        score = 75.0
        highlights.append(f"Good supporting docs present: {', '.join(found)}.")
    elif count == 1:
        score = 50.0
    else:
        score = 15.0
        issues.append("Missing common supporting files (LICENSE, CONTRIBUTING.md, CHANGELOG.md, etc.).")

    # Specific important ones
    has_license = any("license" in f.lower() or f.lower() == "copying" for f in found)
    has_contributing = any("contribut" in f.lower() for f in found)
    if not has_license:
        issues.append("No LICENSE file detected.")
    if not has_contributing and count < 3:
        issues.append("No CONTRIBUTING guide found.")

    return score, details, highlights, issues


def collect_file_stats(root: Path) -> List[FileStats]:
    """Walk the repository and collect statistics for relevant files."""
    stats: List[FileStats] = []
    ignore_dirs = {
        ".git", "node_modules", "venv", ".venv", "env", "__pycache__",
        "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
        "vendor", "third_party", "external",
    }

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored directories
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs and not d.startswith(".")]

        for fname in filenames:
            path = Path(dirpath) / fname
            # Skip very large files and binaries
            try:
                if path.stat().st_size > 1_000_000:  # 1 MB
                    continue
            except OSError:
                continue

            language = detect_language(path)
            if language == "other" and path.suffix not in (".py", ".js", ".ts", ".java", ".go", ".rs", ".rb", ".c", ".cpp", ".h"):
                continue

            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            if language == "python":
                stats.append(analyze_python_file(path, content))
            else:
                stats.append(analyze_generic_file(path, content, language))

    return stats


def analyze_repository(repo_path: Path, repo_url: str) -> AnalysisResult:
    """Run the full documentation quality analysis."""
    root = repo_path
    repo_name = root.name

    file_stats = collect_file_stats(root)

    # Individual scores
    readme_path = find_readme(root)
    readme_score, readme_details, readme_hl, readme_iss = score_readme(readme_path, root)
    docstring_score, docstring_details, docstring_hl, docstring_iss = score_docstrings(file_stats)
    comment_score, comment_details, comment_hl, comment_iss = score_comments(file_stats)
    docs_score, docs_details, docs_hl, docs_iss = score_docs_folder(root)
    support_score, support_details, support_hl, support_iss = score_supporting_docs(root)

    breakdown = {
        "readme": round(readme_score, 1),
        "docstrings": round(docstring_score, 1),
        "comments": round(comment_score, 1),
        "docs_folder": round(docs_score, 1),
        "supporting_docs": round(support_score, 1),
    }

    # Weighted total
    total = (
        breakdown["readme"] * WEIGHTS["readme"]
        + breakdown["docstrings"] * WEIGHTS["docstrings"]
        + breakdown["comments"] * WEIGHTS["comments"]
        + breakdown["docs_folder"] * WEIGHTS["docs_folder"]
        + breakdown["supporting_docs"] * WEIGHTS["supporting_docs"]
    )
    total = round(total, 1)

    # Aggregate highlights & issues (deduplicate lightly)
    highlights = list(dict.fromkeys(readme_hl + docstring_hl + comment_hl + docs_hl + support_hl))
    issues = list(dict.fromkeys(readme_iss + docstring_iss + comment_iss + docs_iss + support_iss))

    # Summary text
    grade = (
        "Excellent" if total >= 85 else
        "Good" if total >= 70 else
        "Fair" if total >= 50 else
        "Poor"
    )
    summary = (
        f"Overall documentation quality score: {total}/100 ({grade}). "
        f"Weighted from README ({breakdown['readme']}), docstring coverage ({breakdown['docstrings']}), "
        f"comment density ({breakdown['comments']}), docs folder ({breakdown['docs_folder']}), "
        f"and supporting files ({breakdown['supporting_docs']})."
    )

    details = {
        "weights": WEIGHTS,
        "readme": readme_details,
        "docstrings": docstring_details,
        "comments": comment_details,
        "docs_folder": docs_details,
        "supporting_docs": support_details,
        "files_analyzed": len(file_stats),
    }

    return AnalysisResult(
        repo_url=repo_url,
        repo_name=repo_name,
        analyzed_at=datetime.now(timezone.utc).isoformat(),
        score=total,
        breakdown=breakdown,
        summary=summary,
        highlights=highlights,
        issues=issues,
        details=details,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Score the documentation quality of a GitHub repository.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python docs_scorer.py https://github.com/psf/requests
  python docs_scorer.py https://github.com/user/repo --output my_score.json
  python docs_scorer.py https://github.com/user/repo --keep-clone
        """,
    )
    parser.add_argument(
        "repo_url",
        help="GitHub repository URL (e.g. https://github.com/owner/repo)",
    )
    parser.add_argument(
        "-o", "--output",
        default="docs_quality_score.json",
        help="Path for the output JSON file (default: docs_quality_score.json)",
    )
    parser.add_argument(
        "--keep-clone",
        action="store_true",
        help="Do not delete the temporary clone after analysis",
    )
    parser.add_argument(
        "--clone-dir",
        default=None,
        help="Optional explicit directory to clone into (default: system temp)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if not is_github_url(args.repo_url):
        print("Error: Please provide a valid GitHub repository URL.", file=sys.stderr)
        return 1

    print(f"Analyzing documentation quality for: {args.repo_url}")
    print("Cloning repository (shallow)...")

    tmp_parent = Path(args.clone_dir) if args.clone_dir else Path(tempfile.mkdtemp(prefix="docs_scorer_"))
    clone_path = tmp_parent / "repo"

    try:
        if clone_path.exists():
            shutil.rmtree(clone_path)
        clone_repo(args.repo_url, clone_path)

        print("Running analysis...")
        result = analyze_repository(clone_path, args.repo_url)

        # Write JSON
        output_path = Path(args.output)
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(asdict(result), f, indent=2, ensure_ascii=False)

        print(f"\nScore: {result.score}/100")
        print(f"Summary: {result.summary}")
        if result.highlights:
            print("\nHighlights:")
            for h in result.highlights:
                print(f"  + {h}")
        if result.issues:
            print("\nIssues:")
            for i in result.issues:
                print(f"  - {i}")
        print(f"\nFull report written to: {output_path.resolve()}")

        return 0

    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    finally:
        if not args.keep_clone and not args.clone_dir:
            try:
                shutil.rmtree(tmp_parent, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
