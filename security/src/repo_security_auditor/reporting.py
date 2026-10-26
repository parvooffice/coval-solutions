from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .models import Finding, RepositoryMetadata, SecurityReport


SEVERITY_WEIGHT = {
    "CRITICAL": 30,
    "HIGH": 18,
    "MEDIUM": 8,
    "LOW": 3,
    "INFO": 1,
}

SECURITY_DOMAIN_WEIGHTS = {
    "Input Validation": 5,
    "Injection": 8,
    "Authentication": 5,
    "Authorization": 7,
    "Session & Tokens": 4,
    "Secrets & Credentials": 5,
    "Cryptography": 5,
    "Sensitive Data Exposure": 5,
    "File & Path Security": 4,
    "Command & Code Execution": 4,
    "Unsafe Deserialization": 3,
    "XSS & Output Encoding": 3,
    "CSRF & Request Integrity": 2,
    "SSRF & URL Handling": 3,
    "Database Security": 4,
    "API Security": 4,
    "Business Logic": 5,
    "Race Conditions & Concurrency": 3,
    "Error Handling": 2,
    "Logging & Security Data": 2,
    "Dependency Security": 4,
    "Configuration Security": 3,
    "Resource & DoS Security": 2,
    "Regex & Parser Security": 2,
    "Permissions & Privilege Use": 3,
    "Third-Party Integrations": 2,
    "Serialization & Data Integrity": 2,
    "Security-Critical Assumptions": 2,
    "Dead / Unused Security Controls": 1,
    "Security-Relevant Complexity": 1,
    "Security-Test Evidence": 1,
    "Runtime Assumptions": 1,
    "Data-Flow Integrity": 5,
    "Attack Surface": 4,
    "General Security": 2,
}


def summarize_findings(findings: list[Finding]) -> dict[str, int]:
    summary = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0, "Info": 0}
    for finding in findings:
        key = finding.severity.title()
        if key == "Critical":
            summary["Critical"] += 1
        elif key == "High":
            summary["High"] += 1
        elif key == "Medium":
            summary["Medium"] += 1
        elif key == "Low":
            summary["Low"] += 1
        else:
            summary["Info"] += 1
    return summary


def _risky_domain_penalty(finding: Finding) -> float:
    return max(0.0, float(finding.risk_score) * (float(finding.confidence) / 100.0))


def calculate_domain_scores(findings: list[Finding]) -> dict[str, float]:
    domain_scores: dict[str, float] = {domain: 100.0 for domain in SECURITY_DOMAIN_WEIGHTS}
    domain_penalties: dict[str, float] = {domain: 0.0 for domain in SECURITY_DOMAIN_WEIGHTS}

    for finding in findings:
        domain = finding.category if finding.category in SECURITY_DOMAIN_WEIGHTS else "General Security"
        domain_penalties[domain] += _risky_domain_penalty(finding)

    for domain, penalty in domain_penalties.items():
        if penalty > 0:
            domain_scores[domain] = max(0.0, 100.0 - (penalty * 4.0))

    return domain_scores


def calculate_overall_score(findings: list[Finding]) -> float:
    if not findings:
        return 100.0

    domain_scores = calculate_domain_scores(findings)
    total_weight = sum(SECURITY_DOMAIN_WEIGHTS.values())
    weighted = sum(domain_scores.get(domain, 100.0) * weight for domain, weight in SECURITY_DOMAIN_WEIGHTS.items())
    score = weighted / total_weight
    return round(score, 1)


def average_confidence(findings: list[Finding]) -> float:
    if not findings:
        return 0.0
    return round(sum(item.confidence for item in findings) / len(findings), 1)


def build_report(metadata: RepositoryMetadata, findings: list[Finding], scanners_run: list[str]) -> SecurityReport:
    summary = summarize_findings(findings)
    ordered_findings = sorted(findings, key=lambda item: (SEVERITY_WEIGHT.get(item.severity, 0), item.risk_score, item.file or ""), reverse=True)
    domain_scores = calculate_domain_scores(ordered_findings)
    report = SecurityReport(
        repo_name=metadata.repo_name,
        repo_url=metadata.repo_url,
        generated_at=datetime.now(timezone.utc).isoformat(),
        overall_score=calculate_overall_score(ordered_findings),
        severity_summary=summary,
        scanners_run=scanners_run,
        findings=ordered_findings,
        metadata=metadata,
        domain_scores=domain_scores,
        average_finding_confidence=average_confidence(ordered_findings),
        notes=[
            "Repository was scanned in an isolated temporary workspace and cleaned afterward.",
            "Findings are prioritized by risk, reachability, and confidence rather than raw issue count.",
        ],
    )
    return report


def save_report(report: SecurityReport, output_dir: str | Path) -> str:
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{report.repo_name}-security-report.json"
    output_path = directory / filename
    output_path.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
    return str(output_path)
