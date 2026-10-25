from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    severity: Severity
    title: str
    description: str
    file: str | None = None
    line: int | None = None
    scanner: str
    evidence: str
    recommendation: str
    risk_score: float = 0.0
    confidence: int = 0
    category: str = "General Security"
    function: str | None = None
    data_flow: str | None = None
    reachability: str | None = None
    impact: str | None = None


class RepositoryMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo_name: str
    repo_url: str
    clone_path: str
    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    package_managers: list[str] = Field(default_factory=list)
    dependency_files: list[str] = Field(default_factory=list)
    config_files: list[str] = Field(default_factory=list)
    ci_cd_files: list[str] = Field(default_factory=list)
    docker_files: list[str] = Field(default_factory=list)
    tests_present: bool = False


class SecurityReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo_name: str
    repo_url: str
    generated_at: str
    overall_score: float
    severity_summary: dict[str, int]
    scanners_run: list[str]
    findings: list[Finding]
    metadata: RepositoryMetadata
    domain_scores: dict[str, float] = Field(default_factory=dict)
    average_finding_confidence: float = 0.0
    notes: list[str] = Field(default_factory=list)
