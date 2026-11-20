#!/usr/bin/env python3
"""COVAL Test Coverage agent.

Statically estimates how well a repository is tested (0-100) without executing any
of its code. It looks at how many source modules have matching tests, how much test
code exists relative to source code, how dense the assertions are, and whether the
project has a test runner, CI, and coverage tooling wired up.

Usage:
    python test_coverage_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

VERSION = "1.0.0"
MAX_FILE_BYTES = 768 * 1024
MAX_FILES = 20_000

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components", "venv", ".venv", "env", "virtualenv",
    "__pycache__", ".tox", ".nox", ".eggs", "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".idea", ".vscode", "build", "dist", "target", ".gradle", ".next", ".nuxt", "coverage", "vendor",
    "third_party", "third-party", "Pods", ".terraform", "obj", "__pypackages__", "_build", "htmlcov",
    "out", ".output", ".vercel", ".turbo", ".cache",
}
SOURCE_EXTENSIONS = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".java": "java", ".go": "go", ".rb": "ruby", ".rs": "rust",
    ".cs": "csharp", ".php": "php", ".kt": "kotlin", ".swift": "swift",
}
SKIP_FILE = re.compile(r"(\.min\.js$|\.bundle\.js$|\.d\.ts$|_pb2(_grpc)?\.py$|\.pb\.go$|\.generated\.|\.config\.[cm]?[jt]s$|^setup\.py$|^manage\.py$|^__init__\.py$|^conftest\.py$)")
TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "e2e", "integration_tests", "unit_tests", "testing"}
TEST_FILE = re.compile(
    r"(^test_.*\.py$|_test\.py$|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.(java|kt|cs)$|^Test[A-Z].*\.(java|kt)$"
    r"|IT\.java$|_spec\.rb$|_test\.rb$|Tests?\.swift$)"
)
NON_PRODUCT_DIRS = {"docs", "doc", "examples", "example", "scripts", "benchmarks", "fixtures", "migrations", "__mocks__", "public", "static", "assets"}
ASSERTION = re.compile(
    r"\bassert\w*\b|\bexpect\s*\(|\.should\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail)\b|\brequire\.\w+\(|\bassert_\w+!?\b"
    r"|\bverify\s*\(|\bself\.assert\w+|\bpytest\.raises\b|\bcheck\s*\("
)
TEST_CASE = re.compile(
    r"^\s*(async\s+)?def\s+test\w*|^\s*(it|test|describe)(\.each\([^)]*\))?\s*\(|^\s*func\s+Test\w+\s*\(|@Test\b|\[Fact\]|\[Test\]"
    r"|^\s*it\s+['\"]|#\[test\]",
    re.M,
)
IMPORT_TARGETS = re.compile(
    r"(?:from\s+([\w.]+)\s+import|import\s+([\w.]+)|require\(\s*['\"]([^'\"]+)['\"]\s*\)|from\s+['\"]([^'\"]+)['\"]|import\s+['\"]([^'\"]+)['\"])"
)

WEIGHTS = {
    "module_coverage": 0.35,
    "test_volume": 0.20,
    "assertion_quality": 0.15,
    "test_infrastructure": 0.15,
    "coverage_tooling": 0.15,
}
LABELS = {
    "module_coverage": "Source modules with matching tests",
    "test_volume": "Test code relative to source code",
    "assertion_quality": "Assertions per test case",
    "test_infrastructure": "Test runner and CI wiring",
    "coverage_tooling": "Coverage measurement tooling",
}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def ramp(value: float, zero_at: float, full_at: float) -> float:
    """Linear 0-100 score between two thresholds (works for ascending or descending ramps)."""
    if zero_at == full_at:
        return 100.0 if value >= full_at else 0.0
    return clamp((value - zero_at) / (full_at - zero_at) * 100.0)


def grade(score: float) -> tuple[str, str]:
    if score >= 85:
        return "A", "Well tested: most modules have focused tests with real assertions, run automatically."
    if score >= 70:
        return "B", "Good test discipline with some untested modules or missing coverage measurement."
    if score >= 55:
        return "C", "Partial testing: important modules lack tests or tests assert little."
    if score >= 35:
        return "D", "Thin testing: few tests exist and they are not wired into an automated workflow."
    return "F", "Largely untested: changes cannot be verified automatically."


def is_test_path(rel: str) -> bool:
    parts = rel.split("/")
    return any(part.lower() in TEST_DIRS for part in parts[:-1]) or bool(TEST_FILE.search(parts[-1]))


def read_text(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def module_stem(rel: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    stem = name.split(".", 1)[0]
    stem = re.sub(r"^(test_|Test)", "", stem)
    stem = re.sub(r"(_test|_spec|Tests?|IT)$", "", stem)
    return stem.lower().replace("-", "_")


def code_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() and not line.strip().startswith(("#", "//", "*", "/*")))


def scan(root: Path) -> dict:
    sources: list[dict] = []
    tests: list[dict] = []
    config_files: list[str] = []
    files_seen = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".") or d == ".github")
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        for name in sorted(filenames):
            files_seen += 1
            if files_seen > MAX_FILES:
                break
            rel = f"{rel_dir}/{name}" if rel_dir else name
            config_files.append(rel)
            ext = os.path.splitext(name)[1].lower()
            language = SOURCE_EXTENSIONS.get(ext)
            if not language:
                continue
            path = Path(dirpath) / name
            if is_test_path(rel):
                text = read_text(path)
                tests.append({"path": rel, "language": language, "text": text, "lines": code_lines(text)})
            elif not SKIP_FILE.search(name) and not any(part.lower() in NON_PRODUCT_DIRS for part in rel.split("/")[:-1]):
                text = read_text(path)
                lines = code_lines(text)
                if lines >= 5:
                    sources.append({"path": rel, "language": language, "lines": lines})
    return {"sources": sources, "tests": tests, "files": config_files, "files_seen": files_seen}


def module_coverage(sources: list[dict], tests: list[dict]) -> tuple[float, list[dict], int]:
    if not sources:
        return 0.0, [], 0
    test_stems = {module_stem(test["path"]) for test in tests}
    referenced: set[str] = set()
    for test in tests:
        for match in IMPORT_TARGETS.finditer(test["text"]):
            target = next(group for group in match.groups() if group)
            last = re.split(r"[./\\]", target.rstrip("/"))[-1]
            referenced.add(last.lower().replace("-", "_"))
    covered = 0
    untested = []
    for source in sources:
        stem = module_stem(source["path"])
        if stem in test_stems or stem in referenced or (stem == "index" and module_stem(source["path"].rsplit("/", 2)[-2] if "/" in source["path"] else "") in referenced):
            covered += 1
        else:
            untested.append(source)
    untested.sort(key=lambda item: item["lines"], reverse=True)
    weighted_total = sum(source["lines"] for source in sources)
    weighted_covered = weighted_total - sum(source["lines"] for source in untested)
    # Blend file count and size so one huge untested module counts, but tiny helpers don't dominate.
    ratio = 0.5 * (covered / len(sources)) + 0.5 * (weighted_covered / max(weighted_total, 1))
    return ramp(ratio, 0.0, 0.8), untested, covered


def infrastructure(files: list[str], read, has_tests: bool) -> tuple[float, list[str], float, list[str]]:
    lowered = {path.lower(): path for path in files}
    signals: list[str] = []
    runner_markers = {
        "pytest.ini": "pytest config", "tox.ini": "tox", "noxfile.py": "nox", "jest.config.js": "Jest config",
        "jest.config.ts": "Jest config", "vitest.config.js": "Vitest config", "vitest.config.ts": "Vitest config",
        "vitest.config.mjs": "Vitest config", "karma.conf.js": "Karma", "playwright.config.ts": "Playwright",
        "playwright.config.js": "Playwright", "cypress.config.js": "Cypress", "cypress.config.ts": "Cypress",
        ".mocharc.json": "Mocha", ".mocharc.yml": "Mocha", "phpunit.xml": "PHPUnit",
    }
    for marker, label in runner_markers.items():
        if marker in lowered:
            signals.append(label)
    package_json = read("package.json")
    if package_json:
        try:
            scripts = json.loads(package_json).get("scripts", {}) or {}
        except (ValueError, AttributeError):
            scripts = {}
        test_script = str(scripts.get("test", ""))
        if test_script and "no test specified" not in test_script:
            signals.append("npm test script")
    pyproject = read("pyproject.toml")
    if "[tool.pytest" in pyproject:
        signals.append("pytest in pyproject")
    if any(path.endswith("_test.go") for path in lowered):
        signals.append("go test")
    if "cargo.toml" in lowered:
        signals.append("cargo test")
    ci_files = [path for path in files if path.lower().startswith(".github/workflows/") or path.lower() in {".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "jenkinsfile", ".travis.yml"}]
    ci_runs_tests = any(re.search(r"\b(test|pytest|jest|vitest|go test|cargo test|mvn|gradle|tox|nox)\b", read(path), re.I) for path in ci_files)
    if ci_runs_tests:
        signals.append("CI runs tests")
    runner_configured = any(signal != "CI runs tests" for signal in signals)
    runner_score = 60 if runner_configured else (30 if has_tests else 0)
    if has_tests and not runner_configured:
        signals.insert(0, "tests follow runner naming conventions, but no runner is configured")
    infra_score = clamp(runner_score + (40 if ci_runs_tests else 0))

    coverage_signals: list[str] = []
    coverage_markers = {".coveragerc": "coverage.py config", "codecov.yml": "Codecov", ".codecov.yml": "Codecov", "coveralls.yml": "Coveralls", ".nycrc": "nyc", ".nycrc.json": "nyc", ".c8rc.json": "c8", "jacoco.xml": "JaCoCo"}
    for marker, label in coverage_markers.items():
        if marker in lowered:
            coverage_signals.append(label)
    haystack = " ".join([package_json, pyproject, read("setup.cfg"), read("tox.ini"), read("pom.xml"), read("build.gradle")] + [read(path) for path in ci_files])
    for pattern, label in ((r"--cov\b|pytest-cov", "pytest-cov"), (r"\bcoverage run\b|\bcoverage report\b|\[tool\.coverage", "coverage.py"), (r"\bc8\b", "c8"), (r"\bnyc\b", "nyc"), (r"--coverage\b|collectCoverage|coverageThreshold", "Jest/Vitest coverage"), (r"-coverprofile|-cover\b", "go cover"), (r"jacoco", "JaCoCo"), (r"codecov|coveralls", "coverage upload")):
        if re.search(pattern, haystack, re.I) and label not in coverage_signals:
            coverage_signals.append(label)
    threshold = bool(re.search(r"fail_under|--cov-fail-under|coverageThreshold|check-coverage|--fail-under", haystack, re.I))
    coverage_score = clamp((70 if coverage_signals else 0) + (30 if threshold else 0))
    if threshold:
        coverage_signals.append("enforced minimum coverage")
    return infra_score, signals, coverage_score, coverage_signals


def analyze_repository(root: Path) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")
    scanned = scan(root)
    sources, tests = scanned["sources"], scanned["tests"]
    if not sources:
        raise ValueError("No source files were found to evaluate.")

    def read(rel: str) -> str:
        return read_text(root / rel)

    coverage_score, untested, covered = module_coverage(sources, tests)
    source_lines = sum(source["lines"] for source in sources)
    test_lines = sum(test["lines"] for test in tests)
    volume_ratio = test_lines / max(source_lines, 1)
    volume_score = ramp(volume_ratio, 0.0, 0.6)

    test_cases = sum(len(TEST_CASE.findall(test["text"])) for test in tests)
    assertions = sum(len(ASSERTION.findall(test["text"])) for test in tests)
    per_case = assertions / max(test_cases, 1)
    empty_test_files = sum(1 for test in tests if test["lines"] and not ASSERTION.search(test["text"]))
    assertion_score = 0.0 if not tests else clamp(ramp(per_case, 0.3, 2.0) - (empty_test_files / len(tests)) * 40)

    infra_score, infra_signals, tooling_score, tooling_signals = infrastructure(scanned["files"], read, bool(tests))
    categories = {
        "module_coverage": {"score": round(coverage_score, 1), "detail": f"{covered} of {len(sources)} source modules have a matching test or are imported by one."},
        "test_volume": {"score": round(volume_score, 1), "detail": f"{test_lines:,} test lines for {source_lines:,} source lines (ratio {volume_ratio:.2f})."},
        "assertion_quality": {"score": round(assertion_score, 1), "detail": f"{assertions:,} assertions across {test_cases:,} test cases; {empty_test_files} test files assert nothing."},
        "test_infrastructure": {"score": round(infra_score, 1), "detail": ", ".join(infra_signals) or "No test runner configuration or CI test step was found."},
        "coverage_tooling": {"score": round(tooling_score, 1), "detail": ", ".join(tooling_signals) or "No coverage measurement is configured."},
    }
    for key, value in categories.items():
        value["label"] = LABELS[key]
        value["weight"] = WEIGHTS[key]
    score = round(sum(categories[key]["score"] * weight for key, weight in WEIGHTS.items()), 1)
    if not tests:
        score = min(score, 15.0)
    letter, interpretation = grade(score)
    weakest = min(categories.items(), key=lambda item: item[1]["score"])
    summary = (
        f"{len(tests)} test files cover {covered}/{len(sources)} source modules. "
        f"Weakest area: {weakest[1]['label'].lower()} ({weakest[1]['score']:.0f}/100)."
    )
    return {
        "tool": "test_coverage",
        "version": VERSION,
        "generated_at": now(),
        "repository": root.name,
        "method": "static",
        "final_score": {"score": score, "grade": letter, "interpretation": interpretation},
        "summary": summary,
        "categories": categories,
        "stats": {
            "source_files": len(sources),
            "test_files": len(tests),
            "source_lines": source_lines,
            "test_lines": test_lines,
            "test_cases": test_cases,
            "assertions": assertions,
            "files_seen": scanned["files_seen"],
        },
        "untested_modules": [{"path": item["path"], "lines": item["lines"]} for item in untested[:15]],
        "recommendations": recommendations(categories, untested),
    }


def recommendations(categories: dict, untested: list[dict]) -> list[str]:
    tips = []
    if untested:
        tips.append("Add tests for the largest untested modules first: " + ", ".join(item["path"] for item in untested[:3]) + ".")
    if categories["assertion_quality"]["score"] < 60:
        tips.append("Make each test assert on behaviour; tests that only call code without checking results catch little.")
    if categories["test_infrastructure"]["score"] < 100:
        tips.append("Run the test suite in CI on every pull request so regressions are caught before merge.")
    if categories["coverage_tooling"]["score"] < 70:
        tips.append("Measure coverage (pytest-cov, c8, Jest --coverage, go test -cover) and set a minimum threshold.")
    return tips


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repo", help="Path to a local checkout (never modified).")
    parser.add_argument("-o", "--output", default="test_coverage_report.json", help="Output JSON path.")
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
        print(f"Test coverage: {final['score']}/100 ({final['grade']}) — {report['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
