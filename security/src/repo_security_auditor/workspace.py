from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path

from .models import RepositoryMetadata


def sanitize_repo_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip())
    return cleaned.strip("-.") or "repository"


def normalize_repo_reference(repo_reference: str) -> str:
    value = repo_reference.strip()
    if not value:
        raise ValueError("Repository reference cannot be empty.")
    if os.path.exists(value):
        return str(Path(value).resolve())
    if value.startswith(("http://", "https://", "git://", "ssh://")):
        return value
    if value.startswith("git@") or "://" in value:
        return value
    if value.endswith(".git") or "/" in value:
        return value
    return value


def clone_repository(repo_reference: str, destination_root: str | None = None) -> str:
    repo_reference = normalize_repo_reference(repo_reference)
    if os.path.exists(repo_reference) and os.path.isdir(repo_reference):
        source = Path(repo_reference).resolve()
        root = Path(destination_root) if destination_root else Path(tempfile.mkdtemp(prefix="repo-audit-"))
        clone_target = root / source.name
        shutil.copytree(
            source,
            clone_target,
            dirs_exist_ok=False,
            ignore=shutil.ignore_patterns(".git", ".venv", "venv", "node_modules", "dist", "build", "__pycache__", ".mypy_cache", ".pytest_cache"),
        )
        return clone_target.resolve().as_posix()

    root = Path(destination_root) if destination_root else Path(tempfile.mkdtemp(prefix="repo-audit-"))
    repo_name = sanitize_repo_name(Path(repo_reference).name.replace(".git", ""))
    clone_target = root / repo_name
    try:
        import git
    except ImportError as error:
        raise RuntimeError("GitPython is required to clone a remote repository directly.") from error

    repo = git.Repo.clone_from(repo_reference, str(clone_target), depth=1)
    if not repo.working_tree_dir:
        raise RuntimeError(f"Failed to clone repository: {repo_reference}")
    return clone_target.resolve().as_posix()


def cleanup_directory(path: str | Path) -> None:
    target = Path(path)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)


def collect_repository_metadata(repo_path: str | Path) -> RepositoryMetadata:
    root = Path(repo_path)
    if not root.exists():
        raise FileNotFoundError(f"Repository path does not exist: {repo_path}")

    files: list[str] = []
    languages: set[str] = set()
    frameworks: set[str] = set()
    package_managers: set[str] = set()
    dependency_files: list[str] = []
    config_files: list[str] = []
    ci_cd_files: list[str] = []
    docker_files: list[str] = []
    excluded_dirs = {".git", ".venv", "venv", "node_modules", "dist", "build", "__pycache__", ".mypy_cache", ".pytest_cache", ".idea"}

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(part in excluded_dirs for part in path.parts):
            continue
        files.append(rel)

    for rel in files:
        lower = rel.lower()
        if rel.endswith((".py", ".pyi")):
            languages.add("Python")
        if rel.endswith((".js", ".jsx", ".ts", ".tsx")):
            languages.add("JavaScript/TypeScript")
        if rel.endswith((".go", ".mod", ".sum")):
            languages.add("Go")
        if rel.endswith((".rs", ".toml")):
            languages.add("Rust")
        if rel.endswith((".java", ".kt", ".gradle")):
            languages.add("Java/Kotlin")
        if rel.endswith((".cs", ".csproj", ".sln")):
            languages.add("C#")
        if rel.endswith((".rb")):
            languages.add("Ruby")

        if lower.endswith("requirements.txt") or lower.endswith("pyproject.toml") or lower.endswith("poetry.lock"):
            if lower.endswith("requirements.txt"):
                dependency_files.append(rel)
            if "requirements" in lower or lower.endswith("pyproject.toml"):
                package_managers.add("pip")
                framework_name = "Python"
                if framework_name not in frameworks:
                    frameworks.add(framework_name)
            if lower.endswith("pyproject.toml"):
                dependency_files.append(rel)

        if lower.endswith("package.json"):
            dependency_files.append(rel)
            package_managers.add("npm")
            frameworks.add("Node.js")
        if "yarn.lock" in lower or "pnpm-lock.yaml" in lower:
            package_managers.add("yarn" if "yarn" in lower else "pnpm")
        if lower.endswith("pom.xml") or lower.endswith("build.gradle") or lower.endswith("build.gradle.kts"):
            package_managers.add("maven" if lower.endswith("pom.xml") else "gradle")
            frameworks.add("Java")
        if "dockerfile" in lower or lower.endswith("docker-compose.yml") or lower.endswith("docker-compose.yaml"):
            docker_files.append(rel)
        if "ci" in lower and (lower.endswith(".yml") or lower.endswith(".yaml")):
            ci_cd_files.append(rel)
        if lower.endswith(".yaml") and ("workflow" in lower or "pipeline" in lower or "gitlab" in lower or "circle" in lower):
            ci_cd_files.append(rel)
        if lower.endswith(".yml") and ("workflow" in lower or "pipeline" in lower or "gitlab" in lower or "circle" in lower):
            ci_cd_files.append(rel)
        if lower.endswith(".env") or lower.endswith(".env.example") or lower.endswith("settings.py") or lower.endswith("config.py"):
            config_files.append(rel)

    if not languages:
        languages.add("Unknown")

    repo_name = sanitize_repo_name(root.name)
    repo_url = "file://" + root.as_posix()
    metadata = RepositoryMetadata(
        repo_name=repo_name,
        repo_url=repo_url,
        clone_path=root.as_posix(),
        languages=sorted(languages),
        frameworks=sorted(frameworks),
        package_managers=sorted(package_managers),
        dependency_files=sorted(set(dependency_files)),
        config_files=sorted(set(config_files)),
        ci_cd_files=sorted(set(ci_cd_files)),
        docker_files=sorted(set(docker_files)),
        tests_present=any(
            rel.lower().startswith("tests/") or "/test_" in rel.lower() or rel.lower().endswith("_test.py") or rel.lower().endswith("test.js")
            for rel in files
        ),
    )
    return metadata
