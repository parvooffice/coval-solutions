from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Severity = Literal["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


@dataclass
class Finding:
    id: str
    severity: Severity
    title: str
    description: str
    scanner: str
    evidence: str
    recommendation: str
    file: str | None = None
    line: int | None = None
    risk_score: float = 0.0
    confidence: int = 0
    category: str = "General Security"
    function: str | None = None
    data_flow: str | None = None
    reachability: str | None = None
    impact: str | None = None


@dataclass
class RepositoryMetadata:
    repo_name: str
    repo_url: str
    clone_path: str
    languages: list[str] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    package_managers: list[str] = field(default_factory=list)
    dependency_files: list[str] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    ci_cd_files: list[str] = field(default_factory=list)
    docker_files: list[str] = field(default_factory=list)
    tests_present: bool = False


@dataclass
class SecurityReport:
    repo_name: str
    repo_url: str
    generated_at: str
    overall_score: float
    severity_summary: dict[str, int]
    scanners_run: list[str]
    findings: list[Finding]
    metadata: RepositoryMetadata
    domain_scores: dict[str, float] = field(default_factory=dict)
    average_finding_confidence: float = 0.0
    notes: list[str] = field(default_factory=list)
