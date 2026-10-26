from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .models import Finding, RepositoryMetadata


SEVERITY_ORDER = {"INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}

CATEGORY_HINTS = {
    "eval": "Command & Code Execution",
    "exec": "Command & Code Execution",
    "shell": "Command & Code Execution",
    "subprocess": "Command & Code Execution",
    "sql": "Injection",
    "query": "Injection",
    "secret": "Secrets & Credentials",
    "token": "Session & Tokens",
    "jwt": "Session & Tokens",
    "auth": "Authentication",
    "csrf": "CSRF & Request Integrity",
    "ssrf": "SSRF & URL Handling",
    "path": "File & Path Security",
    "pickle": "Unsafe Deserialization",
    "yaml": "Unsafe Deserialization",
    "xss": "XSS & Output Encoding",
    "html": "XSS & Output Encoding",
    "crypto": "Cryptography",
    "md5": "Cryptography",
    "sha1": "Cryptography",
    "password": "Secrets & Credentials",
    "api key": "Secrets & Credentials",
    "deserialization": "Unsafe Deserialization",
    "config": "Configuration Security",
    "dependency": "Dependency Security",
    "cors": "Configuration Security",
}


def _severity_to_risk(severity: str) -> float:
    mapping = {"CRITICAL": 9.5, "HIGH": 7.5, "MEDIUM": 5.5, "LOW": 3.2, "INFO": 1.5}
    return mapping.get(severity.upper(), 3.0)


def _calculate_confidence(severity: str) -> int:
    mapping = {"CRITICAL": 95, "HIGH": 88, "MEDIUM": 76, "LOW": 64, "INFO": 52}
    return mapping.get(severity.upper(), 60)


def _category_for_title(title: str, default: str = "General Security") -> str:
    lowered = title.lower()
    for key, category in CATEGORY_HINTS.items():
        if key in lowered:
            return category
    return default


def _add_finding(
    *,
    identifier: str,
    severity: str,
    title: str,
    description: str,
    evidence: str,
    file_path: str | None,
    line_number: int | None,
    recommendation: str,
    scanner_name: str,
    category: str | None = None,
    function_name: str | None = None,
    data_flow: str | None = None,
    reachability: str | None = None,
    impact: str | None = None,
) -> Finding:
    resolved_category = category or _category_for_title(title)
    return Finding(
        id=identifier,
        severity=severity,
        title=title,
        description=description,
        file=file_path,
        line=line_number,
        scanner=scanner_name,
        evidence=evidence,
        recommendation=recommendation,
        risk_score=_severity_to_risk(severity),
        confidence=_calculate_confidence(severity),
        category=resolved_category,
        function=function_name,
        data_flow=data_flow or "Untrusted input -> security-sensitive operation",
        reachability=reachability or "Repository-level reachability requires inspection",
        impact=impact or "Potential confidentiality, integrity, or availability impact",
    )


def heuristic_scan(repo_path: str | Path, metadata: RepositoryMetadata) -> list[Finding]:
    repo_root = Path(repo_path)
    findings: list[Finding] = []
    heuristics = [
        (
            "dynamic-code-execution",
            r"\b(?:eval|exec|compile)\s*\(",
            "HIGH",
            "Dynamic code execution detected",
            "Functions such as eval/exec permit code injection and arbitrary command execution.",
            "Avoid dynamic execution of untrusted input. Prefer explicit parsing, validation, and safer APIs.",
            "Command & Code Execution",
        ),
        (
            "weak-crypto",
            r"\b(?:md5|sha1|DES|RC4)\b",
            "MEDIUM",
            "Weak hashing or encryption algorithm used",
            "The project references legacy cryptographic primitives that are generally considered weak.",
            "Use modern algorithms such as SHA-256 or AES-GCM, and rotate any affected secrets.",
            "Cryptography",
        ),
        (
            "command-injection",
            r"subprocess\.(?:call|run|Popen)\([^\n]*shell\s*=\s*True",
            "HIGH",
            "Shell command execution with shell enabled",
            "A subprocess call is configured to run via a shell. This could allow command injection.",
            "Set shell=False when possible and avoid concatenating user-controlled strings into commands.",
            "Command & Code Execution",
        ),
        (
            "hardcoded-secret",
            r"(?:API_KEY|SECRET_KEY|PASSWORD|TOKEN|PRIVATE_KEY)\s*[:=]\s*[\"'][^\"']{8,}[\"']",
            "HIGH",
            "Hardcoded credential or secret-like value",
            "A secret or credential-like value is embedded directly in source code.",
            "Move secrets to environment variables or a secure secret manager and never store them in the repository.",
            "Secrets & Credentials",
        ),
        (
            "sql-string-concat",
            r"(?:SELECT|INSERT|UPDATE|DELETE).*\+|f[\"'].*(?:SELECT|INSERT|UPDATE|DELETE)",
            "HIGH",
            "Potential SQL injection pattern",
            "Dynamic SQL is assembled from strings or format operations, a common injection vector.",
            "Use parameterized queries or ORMs and validate all user-supplied input.",
            "Injection",
        ),
        (
            "jwt-secret-default",
            r"JWT_SECRET|SECRET_KEY\s*[:=].*(?:change-me|default|example|test)",
            "MEDIUM",
            "Default or placeholder secret detected",
            "The application appears to use a default or placeholder secret value.",
            "Replace placeholder secrets with strong random values and ensure production environments load them securely.",
            "Session & Tokens",
        ),
    ]

    for path in repo_root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in {".git", ".venv", "venv", "node_modules", "dist", "build", "site-packages"} for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        relative = path.relative_to(repo_root).as_posix()
        for identifier, pattern, severity, title, description, recommendation, category in heuristics:
            match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
            if not match:
                continue
            line_no = text[: match.start()].count("\n") + 1
            findings.append(
                _add_finding(
                    identifier=f"{identifier}-{len(findings) + 1}",
                    severity=severity,
                    title=title,
                    description=description,
                    evidence=match.group(0)[:180],
                    file_path=relative,
                    line_number=line_no,
                    recommendation=recommendation,
                    scanner_name="heuristic-analysis",
                    category=category,
                    function_name="repository heuristic",
                    data_flow="Input or configuration value -> executable / secret-bearing sink",
                    reachability="Code path is directly reachable from repository logic",
                    impact="Potential remote code execution, secret leakage, or data compromise",
                )
            )
    return findings


def external_tool_scan(repo_path: str | Path, metadata: RepositoryMetadata) -> list[Finding]:
    repo_root = Path(repo_path)
    findings: list[Finding] = []
    scanners = []

    if any("Python" in language for language in metadata.languages):
        scanners.append(("bandit", ["bandit", "-r", str(repo_root), "-f", "json"], "bandit"))
    if any("JavaScript/TypeScript" in language for language in metadata.languages):
        scanners.append(("npm-audit", ["npm", "audit", "--json"], "dependency-audit"))
    scanners.append(("detect-secrets", ["detect-secrets", "scan", "--all-files", "--disable-plugin", "AbsolutePathDetectorThreshold", str(repo_root)], "secret-detection"))
    scanners.append(("semgrep", ["semgrep", "--config=auto", "--json", str(repo_root)], "semgrep"))

    for label, command, scanner_name in scanners:
        try:
            result = subprocess.run(command, cwd=str(repo_root), capture_output=True, text=True, check=False)
        except FileNotFoundError:
            continue
        payload = result.stdout.strip() or result.stderr.strip()
        if not payload:
            continue

        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue

        if scanner_name == "bandit":
            for result_item in parsed.get("results", []):
                category = _category_for_title(result_item.get("issue_text", "security issue"))
                findings.append(
                    _add_finding(
                        identifier=f"bandit-{len(findings) + 1}",
                        severity=result_item.get("issue_severity", "MEDIUM").upper(),
                        title=result_item.get("issue_text", "Bandit issue"),
                        description=result_item.get("issue_text", "Bandit found a potential security issue."),
                        evidence=result_item.get("filename", "unknown"),
                        file_path=result_item.get("filename"),
                        line_number=result_item.get("line_number"),
                        recommendation="Review the flagged code path and remediate the identified weakness.",
                        scanner_name="bandit",
                        category=category,
                        function_name=result_item.get("test_id", "bandit check"),
                        data_flow="Operational logic -> security-sensitive function",
                        reachability="Bandit-flagged code path is executable in repository context",
                        impact="Potential compromise of security posture, data, or runtime integrity",
                    )
                )
        elif scanner_name == "dependency-audit":
            for package_name, vulnerability in parsed.get("vulnerabilities", {}).items():
                if not isinstance(vulnerability, dict):
                    continue
                severity = str(vulnerability.get("severity", "MEDIUM")).upper()
                if severity not in SEVERITY_ORDER:
                    severity = "MEDIUM"
                details = next((item for item in vulnerability.get("via", []) if isinstance(item, dict)), {})
                title = details.get("title") or f"Vulnerable dependency: {package_name}"
                affected_range = vulnerability.get("range") or details.get("range")
                evidence_parts = [package_name]
                if affected_range:
                    evidence_parts.append(f"affected range {affected_range}")
                nodes = vulnerability.get("nodes")
                if nodes:
                    evidence_parts.append(f"installed at {', '.join(str(node) for node in nodes[:3])}")
                findings.append(
                    _add_finding(
                        identifier=f"npm-audit-{re.sub(r'[^A-Za-z0-9._-]+', '-', package_name)}",
                        severity=severity,
                        title=title[:180],
                        description=f"npm audit reported a {severity.lower()} vulnerability in {package_name}.",
                        evidence="; ".join(evidence_parts)[:180],
                        file_path="package-lock.json",
                        line_number=None,
                        recommendation="Upgrade the dependency to a patched version and review npm audit's remediation guidance.",
                        scanner_name="npm-audit",
                        category="Dependency Security",
                        function_name="npm audit",
                        data_flow="Dependency manifest -> installed package -> application runtime",
                        reachability="Package is listed in the repository dependency audit results",
                        impact="A vulnerable dependency may expose the application to known attacks.",
                    )
                )
        elif scanner_name == "secret-detection":
            for result_item in parsed.get("results", {}).values():
                file_value = result_item.get("file") if isinstance(result_item, dict) else None
                findings.append(
                    _add_finding(
                        identifier=f"secret-{len(findings) + 1}",
                        severity="HIGH",
                        title="Potential secret or credential detected",
                        description="A secret-like value was detected by the detector.",
                        evidence=str(result_item)[:180],
                        file_path=file_value,
                        line_number=result_item.get("line_number") if isinstance(result_item, dict) else None,
                        recommendation="Validate and rotate any secret if it is real, then move it to a managed secret store.",
                        scanner_name="detect-secrets",
                        category="Secrets & Credentials",
                        function_name="secret detection",
                        data_flow="Repository data -> secret-bearing sink",
                        reachability="Secret is present in repository contents and may be reachable",
                        impact="Exposure of credentials can lead to account takeover or data loss",
                    )
                )
        elif scanner_name == "semgrep":
            for result_item in parsed.get("results", []):
                title = result_item.get("check_id", "Semgrep finding")
                category = _category_for_title(title)
                findings.append(
                    _add_finding(
                        identifier=f"semgrep-{len(findings) + 1}",
                        severity=result_item.get("extra", {}).get("severity", "MEDIUM").upper(),
                        title=title,
                        description=result_item.get("extra", {}).get("message", "Semgrep found a code pattern that may be risky."),
                        evidence=result_item.get("path", "unknown"),
                        file_path=result_item.get("path"),
                        line_number=result_item.get("start", {}).get("line") if isinstance(result_item.get("start"), dict) else None,
                        recommendation="Review the matched rule and remediate the underlying issue in code or configuration.",
                        scanner_name="semgrep",
                        category=category,
                        function_name=result_item.get("check_id", "semgrep rule"),
                        data_flow="Repository source -> potentially dangerous pattern",
                        reachability="Semgrep match indicates a reachable risky pattern in code",
                        impact="Potential security regression depending on execution path and inputs",
                    )
                )

    return findings


def build_scanner_plan(metadata: RepositoryMetadata) -> list[str]:
    plan: list[str] = ["heuristic-analysis"]
    if "Python" in metadata.languages:
        plan.append("bandit")
    if "JavaScript/TypeScript" in metadata.languages:
        plan.append("dependency-audit")
    plan.extend(["detect-secrets", "semgrep"])
    return sorted(set(plan))
