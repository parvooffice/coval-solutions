#!/usr/bin/env python3
"""Run the existing repository analyzers for each target in code-evaluation-urls.txt."""

from __future__ import annotations

import json
import io
import os
import re
import shutil
import stat
import subprocess
import sys
import argparse
from concurrent.futures import ThreadPoolExecutor
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
URL_FILE = ROOT / "code-evaluation-urls.txt"
OUTPUT_FILE = ROOT / "app" / "data" / "code-evaluation.json"
DOCS_DIR = ROOT / "documentation"
MODULARITY_DIR = ROOT / "modularity"
SECURITY_DIR = ROOT / "security"


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-.") or "repository"


def read_targets(values: list[str] | None = None) -> list[dict[str, str]]:
    targets = []
    source_values = values if values is not None else (URL_FILE.read_text(encoding="utf-8").splitlines() if URL_FILE.exists() else [])
    for raw_value in source_values:
        value = raw_value.strip()
        if not value or value.startswith("#"):
            continue
        parsed = urlparse(value)
        if parsed.scheme == "https" and parsed.hostname and parsed.hostname.lower() == "github.com":
            parts = [part for part in parsed.path.strip("/").split("/") if part]
            if len(parts) != 2 or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError(f"Target must be a repository URL such as https://github.com/owner/repo: {value}")
            owner, repo = parts
            repo = repo.removesuffix(".git")
            canonical = f"https://github.com/{owner}/{repo}"
            name = safe_name(f"{owner}-{repo}")
            targets.append({"input": canonical, "name": name, "source": "github", "argument": canonical})
            continue
        if values is not None:
            raise ValueError(f"Dynamic evaluations accept GitHub repository URLs only: {value}")
        path = Path(value)
        if not path.is_absolute():
            path = ROOT / path
        path = path.resolve()
        if not path.is_dir():
            raise ValueError(f"Target is not a GitHub URL or local directory: {value}")
        targets.append({"input": value, "name": safe_name(path.name), "source": "local", "argument": str(path), "path": str(path)})
    return targets


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def security_summary(value: object) -> str:
    if isinstance(value, dict):
        ordered = ("Critical", "High", "Medium", "Low", "Info")
        counts = [f"{key}: {value[key]}" for key in ordered if key in value]
        return "Findings by severity · " + " · ".join(counts) if counts else json.dumps(value)
    return str(value or "")


def run_process(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "Analyzer exited unsuccessfully.").strip()
        raise RuntimeError(details[-2500:])


def docs_report(target: dict[str, str], report_path: Path, env: dict[str, str] | None = None) -> dict:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if target.get("workspace_path"):
        sys.path.insert(0, str(DOCS_DIR))
        from docs_scorer import analyze_repository

        local_path = Path(target["workspace_path"])
        report = asdict(analyze_repository(local_path, target["input"]))
        write_json(report_path, report)
    elif target["source"] == "github":
        run_process(
            [sys.executable, str(DOCS_DIR / "docs_scorer.py"), target["argument"], "--output", str(report_path)],
            cwd=ROOT,
            env=env,
        )
    else:
        sys.path.insert(0, str(DOCS_DIR))
        from docs_scorer import analyze_repository

        local_path = Path(target["path"])
        report = asdict(analyze_repository(local_path, local_path.as_uri()))
        write_json(report_path, report)
    return json.loads(report_path.read_text(encoding="utf-8"))


MAX_ARCHIVE_BYTES = 75 * 1024 * 1024
MAX_EXTRACTED_BYTES = 150 * 1024 * 1024
MAX_ARCHIVE_FILES = 20_000


def download_repository_archive(target: dict[str, str], destination: Path, env: dict[str, str], ref: str = "") -> Path:
    """Download a GitHub zipball (optionally at a commit/branch), then extract only safe, bounded regular files."""
    parsed = urlparse(target["input"])
    owner, repository = parsed.path.strip("/").split("/")
    endpoint = f"https://api.github.com/repos/{owner}/{repository}/zipball"
    if ref:
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", ref) or ".." in ref:
            raise ValueError("Invalid Git reference.")
        endpoint += f"/{ref}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "COVAL-code-evaluation",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = env.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(endpoint, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            final_host = (urlparse(response.geturl()).hostname or "").lower()
            if final_host not in {"api.github.com", "codeload.github.com", "github.com"}:
                raise RuntimeError("GitHub returned an unexpected archive host.")
            chunks = []
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("Repository archive exceeds the 75 MB download limit.")
                chunks.append(chunk)
    except urllib.error.HTTPError as error:
        if error.code in {401, 403, 404}:
            raise RuntimeError(
                f"GitHub could not read {owner}/{repository} (HTTP {error.code}). Check that the repository is accessible and GITHUB_TOKEN has read access for private repositories."
            ) from error
        raise RuntimeError(f"GitHub archive download failed with HTTP {error.code}.") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not connect to GitHub: {error.reason}") from error

    archive = b"".join(chunks)
    extract_root = destination / "repository"
    extract_root.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            entries = zipped.infolist()
            if len(entries) > MAX_ARCHIVE_FILES:
                raise RuntimeError(f"Repository archive contains more than {MAX_ARCHIVE_FILES} files.")
            uncompressed_size = sum(entry.file_size for entry in entries)
            if uncompressed_size > MAX_EXTRACTED_BYTES:
                raise RuntimeError("Repository archive expands beyond the 150 MB analysis limit.")
            for entry in entries:
                member = entry.filename
                parts = member.rstrip("/").split("/")
                if not member or member.startswith("/") or "\\" in member or any(part in {"", ".", ".."} for part in parts):
                    raise RuntimeError("GitHub returned an archive with an unsafe file path.")
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode):
                    continue
                output = extract_root.joinpath(*parts)
                resolved = output.resolve()
                if extract_root.resolve() not in resolved.parents and resolved != extract_root.resolve():
                    raise RuntimeError("GitHub returned an archive with an unsafe file path.")
                if entry.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                    continue
                output.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(entry) as source, output.open("wb") as target_file:
                    shutil.copyfileobj(source, target_file, length=1024 * 1024)
    except zipfile.BadZipFile as error:
        raise RuntimeError("GitHub returned an invalid repository archive.") from error

    roots = [path for path in extract_root.iterdir() if path.is_dir()]
    if len(roots) == 1:
        return roots[0]
    if any(extract_root.iterdir()):
        return extract_root
    raise RuntimeError("The repository archive did not contain any files.")


# Generated or data files that skew results; removed from the temporary copy before scoring.
DEFAULT_IGNORES = (
    "**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.next/**", "**/vendor/**",
    "**/*.min.js", "**/*.min.css", "**/*.map", "**/__snapshots__/**", "**/*.snap",
    "**/reports/**/*.json", "**/*-report.json", "**/fixtures/**/*.json",
)
MAX_IGNORE_PATTERNS = 100


def read_coval_config(workspace: Path) -> list[str]:
    """Parse the `ignore:` list from .coval.yml / .coval.yaml (a small YAML subset, no dependency)."""
    for name in (".coval.yml", ".coval.yaml"):
        path = workspace / name
        if not path.is_file() or path.stat().st_size > 64 * 1024:
            continue
        patterns, in_ignore = [], False
        for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            if not raw.startswith((" ", "	", "-")):
                in_ignore = line.strip().rstrip(":") == "ignore"
                continue
            item = line.strip()
            if in_ignore and item.startswith("- "):
                value = item[2:].strip().strip("'\"")
                if value and ".." not in value and not value.startswith("/"):
                    patterns.append(value if "*" in value or "." in Path(value).name else value.rstrip("/") + "/**")
        return patterns[:MAX_IGNORE_PATTERNS]
    return []


def prune_workspace(workspace: Path) -> int:
    """Delete ignored files from a temporary checkout. Never call this on a real working tree."""
    patterns = [*DEFAULT_IGNORES, *read_coval_config(workspace)]
    removed = 0
    for path in sorted(workspace.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(workspace).as_posix()
        if any(Path(relative).match(pattern) or Path("x/" + relative).match(pattern) for pattern in patterns):
            path.unlink()
            removed += 1
    return removed


def run_remote_targets(urls: list[str], access: dict | None = None) -> dict:
    """Run the analyzers against downloaded GitHub source in a temp directory.

    `access` optionally maps a repository URL to {"token": ..., "ref": ...}: a short-lived
    GitHub App installation token for private repositories, and a commit or branch to score.
    """
    access = access or {}
    if not isinstance(urls, list) or any(not isinstance(value, str) for value in urls):
        raise ValueError("Submit repository URLs as a list of strings.")
    targets = read_targets(urls)
    if not targets:
        raise ValueError("Add at least one GitHub repository URL.")
    if len(targets) > 5:
        raise ValueError("Evaluate up to five repositories per run.")

    env = os.environ.copy()
    token = env.get("GITHUB_TOKEN", "").strip()
    if token:
        import base64

        credential = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
        env["GIT_CONFIG_VALUE_0"] = f"AUTHORIZATION: basic {credential}"

    results = []
    for target in targets:
        with tempfile.TemporaryDirectory(prefix="coval-repository-evaluation-") as temporary:
            work_dir = Path(temporary)
            target_access = access.get(target["input"]) or access.get(target["input"].lower()) or {}
            target_env = {**env, "GITHUB_TOKEN": target_access["token"]} if target_access.get("token") else env
            workspace = download_repository_archive(target, work_dir, target_env, target_access.get("ref", ""))
            ignored_files = prune_workspace(workspace)
            analyzed_target = {
                **target,
                "argument": str(workspace),
                "path": str(workspace),
                "workspace_path": str(workspace),
                "url": target["input"],
            }
            result = run_one(analyzed_target, work_dir / "reports", env)
            result["ignoredFiles"] = ignored_files
            if target_access.get("ref"):
                result["ref"] = target_access["ref"]
            results.append(result)

    return {
        "schemaVersion": 1,
        "generatedAt": now(),
        "urlFile": "submitted repository URLs",
        "targets": results,
    }


def modularity_report(target: dict[str, str], report_path: Path, env: dict[str, str] | None = None) -> dict:
    run_process(
        [sys.executable, str(MODULARITY_DIR / "analyze_modularity.py"), target["argument"], "--output", str(report_path), "--quiet"],
        cwd=ROOT,
        env=env,
    )
    return json.loads(report_path.read_text(encoding="utf-8"))


def security_report(target: dict[str, str], report_dir: Path, env: dict[str, str] | None = None) -> tuple[dict, Path]:
    source_dir = SECURITY_DIR / "src"
    source_path = str(source_dir)
    if source_path not in sys.path:
        sys.path.insert(0, source_path)
    from repo_security_auditor import run_repository_audit

    report_dir.mkdir(parents=True, exist_ok=True)
    report = run_repository_audit(target["argument"], output_dir=str(report_dir))
    report_path = report_dir / f"{safe_name(report.repo_name)}-security-report.json"
    if not report_path.is_file():
        raise RuntimeError("The security analyzer did not write a JSON report.")
    return json.loads(report_path.read_text(encoding="utf-8")), report_path


# Standard-library agents that share one CLI contract: `<script> PATH --output FILE --quiet`
# and a report with `final_score`, `summary`, and `categories`.
STATIC_AGENTS = (
    {"id": "readability", "label": "Readability", "directory": "readability", "script": "readability_scorer.py"},
    {"id": "test_coverage", "label": "Test coverage", "directory": "test-coverage", "script": "test_coverage_scorer.py"},
    {"id": "performance", "label": "Performance", "directory": "performance", "script": "performance_scorer.py"},
    {"id": "maintainability", "label": "Maintainability", "directory": "maintainability", "script": "maintainability_scorer.py"},
    {"id": "scalability", "label": "Scalability", "directory": "scalability", "script": "scalability_scorer.py"},
    {"id": "standards", "label": "Standards compliance", "directory": "standards", "script": "standards_scorer.py"},
)


def static_agent_evaluation(agent: dict[str, str], target: dict[str, str], report_root: Path | None, stem: str, env: dict[str, str] | None) -> dict:
    agent_dir = ROOT / agent["directory"]
    report_path = (report_root / agent["directory"] if report_root else agent_dir / "reports") / f"{stem}-{agent['directory']}-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_name = report_path.name if report_root else report_path.relative_to(ROOT).as_posix()
    try:
        run_process(
            [sys.executable, str(agent_dir / agent["script"]), target.get("workspace_path", target["argument"]), "--output", str(report_path), "--quiet"],
            cwd=ROOT,
            env=env,
        )
        report = json.loads(report_path.read_text(encoding="utf-8"))
        final_score = report.get("final_score", {})
        return {
            "id": agent["id"], "label": agent["label"], "status": "complete",
            "score": final_score.get("score"), "grade": final_score.get("grade"),
            "summary": report.get("summary", final_score.get("interpretation", "")),
            "breakdown": {key: {"label": value.get("label", key), "score": value.get("score")} for key, value in report.get("categories", {}).items()},
            "fixes": static_agent_fixes(agent["id"], report),
            "reportPath": report_name,
        }
    except Exception as error:  # Keep other analyzer reports even if one agent fails.
        return {"id": agent["id"], "label": agent["label"], "status": "failed", "score": None, "error": str(error)}


SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
MAX_FIXES = 3


def fix(title: str, location: str = "", detail: str = "") -> dict:
    return {key: value for key, value in {"title": title, "location": location, "detail": detail}.items() if value}


def report_location(root: Path | None, path: Path) -> str:
    return path.name if root else path.relative_to(ROOT).as_posix()


def documentation_evaluation(target: dict[str, str], report_root: Path | None, stem: str, env: dict[str, str] | None) -> dict:
    docs_path = (report_root / "documentation" if report_root else ROOT / "documentation" / "reports") / f"{stem}-documentation-report.json"
    try:
        report = docs_report(target, docs_path, env)
        return {
            "id": "documentation", "label": "Documentation", "status": "complete",
            "score": report.get("score"), "summary": report.get("summary", ""),
            "breakdown": report.get("breakdown", {}),
            "fixes": [fix(issue) for issue in report.get("issues", [])[:MAX_FIXES] if isinstance(issue, str)],
            "reportPath": report_location(report_root, docs_path),
        }
    except Exception as error:  # Keep other analyzer reports even if one tool fails.
        write_json(docs_path, {"tool": "documentation", "status": "failed", "error": str(error), "generated_at": now()})
        return {"id": "documentation", "label": "Documentation", "status": "failed", "score": None, "error": str(error), "reportPath": report_location(report_root, docs_path)}


def modularity_evaluation(target: dict[str, str], report_root: Path | None, stem: str, env: dict[str, str] | None) -> dict:
    modularity_path = (report_root / "modularity" if report_root else ROOT / "modularity" / "reports") / f"{stem}-modularity-report.json"
    try:
        report = modularity_report(target, modularity_path, env)
        overall = report.get("overall", {})
        dimensions = report.get("dimensions", {})
        offenders = (report.get("top_offenders") or {}).get("files", [])
        return {
            "id": "modularity", "label": "Modularity", "status": "complete",
            "score": overall.get("score"), "grade": overall.get("grade"),
            "summary": overall.get("interpretation", ""),
            "breakdown": {key: {"label": value.get("label", key), "score": value.get("score")} for key, value in dimensions.items()},
            "fixes": [fix("Split or simplify this module", item.get("path", ""), "; ".join(item.get("reasons", [])[:2])) for item in offenders[:MAX_FIXES]],
            "reportPath": report_location(report_root, modularity_path),
        }
    except Exception as error:
        write_json(modularity_path, {"tool": "modularity", "status": "failed", "error": str(error), "generated_at": now()})
        return {"id": "modularity", "label": "Modularity", "status": "failed", "score": None, "error": str(error), "reportPath": report_location(report_root, modularity_path)}


def security_evaluation(target: dict[str, str], report_root: Path | None, stem: str, env: dict[str, str] | None) -> dict:
    security_dir = report_root / "security" / stem if report_root else SECURITY_DIR / "reports"
    try:
        report, source_report_path = security_report(target, security_dir, env)
        expected_report_path = security_dir / f"{safe_name(report.get('repo_name', stem))}-security-report.json"
        if source_report_path != expected_report_path:
            expected_report_path.parent.mkdir(parents=True, exist_ok=True)
            expected_report_path.write_text(source_report_path.read_text(encoding="utf-8"), encoding="utf-8")
        findings = sorted(report.get("findings", []), key=lambda item: SEVERITY_RANK.get(str(item.get("severity", "")).lower(), 5))
        return {
            "id": "security", "label": "Security", "status": "complete",
            "score": report.get("overall_score"), "summary": security_summary(report.get("severity_summary")),
            "breakdown": report.get("domain_scores", {}),
            "findingCount": len(report.get("findings", [])),
            "fixes": [
                fix(f"{str(item.get('severity', '')).title()}: {item.get('title', 'Security finding')}",
                    f"{item['file']}:{item['line']}" if item.get("file") and item.get("line") else item.get("file", ""),
                    item.get("recommendation", ""))
                for item in findings[:MAX_FIXES]
            ],
            "reportPath": report_location(report_root, expected_report_path),
            "generatedAt": report.get("generated_at"),
        }
    except Exception as error:
        return {"id": "security", "label": "Security", "status": "failed", "score": None, "error": str(error)}


def error_handling_evaluation(target: dict[str, str], report_root: Path | None, stem: str, env: dict[str, str] | None) -> dict:
    error_handling_path = (report_root / "error-handling" if report_root else ROOT / "error-handling" / "reports") / f"{stem}-error-handling-report.json"
    error_handling_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_process(
            [sys.executable, str(ROOT / "error-handling" / "error_handling_scorer.py"), target.get("workspace_path", target["argument"]), "--output", str(error_handling_path), "--quiet", "--no-progress"],
            cwd=ROOT,
            env=env,
        )
        report = json.loads(error_handling_path.read_text(encoding="utf-8"))
        final_score = report.get("final_score", {})
        issues = sorted(report.get("issues", []), key=lambda item: (SEVERITY_RANK.get(str(item.get("severity", "")).lower(), 5), -int(item.get("count") or 0)))
        return {
            "id": "error_handling", "label": "Error handling", "status": "complete",
            "score": final_score.get("score"), "grade": final_score.get("grade"),
            "summary": report.get("summary", final_score.get("interpretation", "")),
            "confidence": final_score.get("confidence"),
            "breakdown": {key: {"label": value.get("label", key), "score": value.get("score")} for key, value in report.get("categories", {}).items()},
            "fixes": [
                fix(f"{item.get('description', item.get('type', 'Issue'))} ({item.get('count', 0)}×)",
                    ((item.get("examples") or [{}])[0]).get("location", ""),
                    ((item.get("examples") or [{}])[0]).get("detail", ""))
                for item in issues[:MAX_FIXES]
            ],
            "reportPath": report_location(report_root, error_handling_path),
        }
    except Exception as error:
        return {"id": "error_handling", "label": "Error handling", "status": "failed", "score": None, "error": str(error)}


def static_agent_fixes(agent_id: str, report: dict) -> list[dict]:
    if agent_id == "readability":
        return [
            fix(f"Simplify {item['name'] or 'this function'}", f"{item['path']}:{item['line']}",
                f"{item['length']} lines, {item['complexity']} decision points, nesting depth {item['nesting']}")
            for item in report.get("hotspots", [])[:MAX_FIXES]
        ]
    if agent_id == "test_coverage":
        return [fix("Add tests for this module", item["path"], f"{item['lines']} lines with no matching test") for item in report.get("untested_modules", [])[:MAX_FIXES]]
    return [item for item in report.get("fixes", []) if isinstance(item, dict)][:MAX_FIXES]


AGENT_RUNNERS = (documentation_evaluation, modularity_evaluation, security_evaluation, error_handling_evaluation)


def run_one(target: dict[str, str], report_root: Path | None = None, env: dict[str, str] | None = None) -> dict:
    stem = target["name"]
    # The agents are independent, so run them side by side; results keep a fixed order.
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(runner, target, report_root, stem, env) for runner in AGENT_RUNNERS]
        futures += [pool.submit(static_agent_evaluation, agent, target, report_root, stem, env) for agent in STATIC_AGENTS]
        evaluations = [future.result() for future in futures]

    is_local = target["source"] == "local"
    local_uri = "local-workspace" if is_local else target.get("url", target["argument"])
    return {
        "name": "COVAL workspace" if is_local and Path(target["path"]) == ROOT else target["name"],
        "input": "Local workspace" if is_local else target["input"], "source": target["source"], "url": local_uri,
        "generatedAt": now(), "evaluations": evaluations,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets-json", help="JSON array of GitHub repository URLs; reads the URL dump when omitted.")
    parser.add_argument("--local-workspace", action="store_true", help="Score this COVAL checkout directly (local development).")
    parser.add_argument("--output", help="Aggregate JSON output path (defaults to app/data/code-evaluation.json).")
    parser.add_argument("--report-dir", help="Directory for this run's analyzer reports; isolates reports from other users and runs.")
    args = parser.parse_args()

    if args.local_workspace and args.targets_json:
        parser.error("--local-workspace cannot be combined with --targets-json.")
    values = json.loads(args.targets_json) if args.targets_json else None
    if values is not None and (not isinstance(values, list) or any(not isinstance(value, str) for value in values)):
        raise ValueError("--targets-json must be a JSON array of strings.")
    if args.local_workspace:
        workspace = ROOT.resolve()
        targets = [{
            "input": str(workspace),
            "name": safe_name(workspace.name),
            "source": "local",
            "argument": str(workspace),
            "path": str(workspace),
        }]
    else:
        targets = read_targets(values)
    report_root = Path(args.report_dir).resolve() if args.report_dir else None
    analyzer_env = os.environ.copy()
    token = analyzer_env.get("GITHUB_TOKEN", "").strip()
    if token:
        import base64
        credential = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        analyzer_env["GIT_CONFIG_COUNT"] = "1"
        analyzer_env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
        analyzer_env["GIT_CONFIG_VALUE_0"] = f"AUTHORIZATION: basic {credential}"
    if values is not None:
        # Same path as the cloud function: download each repository once and share it with every agent.
        bundle = run_remote_targets(values)
    else:
        bundle = {
            "schemaVersion": 1,
            "generatedAt": now(),
            "urlFile": URL_FILE.name,
            "targets": [run_one(target, report_root, analyzer_env) for target in targets],
        }
    output_path = Path(args.output).resolve() if args.output else OUTPUT_FILE
    write_json(output_path, bundle)
    print(f"Wrote analyzer scores to {output_path}")
    for target in bundle["targets"]:
        scores = ", ".join(f"{item['label']}: {item['score'] if item['score'] is not None else 'unavailable'}" for item in target["evaluations"])
        print(f"{target['name']}: {scores}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
