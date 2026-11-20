#!/usr/bin/env python3
"""COVAL Scalability agent.

Statically scores how well a repository will hold up as traffic grows (0-100):
externalized configuration, timeouts on network calls, bounded queries, stateless
server code, and deployment readiness.

Usage: python scalability_scorer.py PATH [--output report.json] [--quiet]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-kit"))
from coval_agent_kit import build_report, fix, ramp, run_cli, source_files, walk_files  # noqa: E402

VERSION = "1.0.0"
WEIGHTS = {"config_externalized": 0.20, "network_resilience": 0.25, "bounded_queries": 0.15, "stateless_design": 0.20, "deployment_readiness": 0.20}
LABELS = {
    "config_externalized": "Configuration comes from the environment",
    "network_resilience": "Network calls have timeouts",
    "bounded_queries": "Queries are bounded",
    "stateless_design": "Stateless server code",
    "deployment_readiness": "Ready to deploy and scale out",
}
INTERPRETATIONS = {
    "A": "Ready to scale: stateless, configurable, and resilient.",
    "B": "Scales well with a few gaps to close.",
    "C": "Will need work before handling much more traffic.",
    "D": "Likely to break under load or across multiple instances.",
    "F": "Built for a single machine; significant work needed to scale.",
}
HARDCODED_HOST = re.compile(r"[\"'`]https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?|[\"'`](localhost|127\.0\.0\.1):\d{2,5}")
ENV_USE = re.compile(r"process\.env|os\.environ|os\.getenv|import\.meta\.env|System\.getenv|os\.Getenv")
NETWORK_CALL = re.compile(r"\bfetch\(|\brequests\.(get|post|put|patch|delete|request)\(|\burlopen\(|\baxios(\.\w+)?\(|\bhttpx\.(get|post|put|patch|delete)\(|\bhttp\.(Get|Post)\(")
TIMEOUT = re.compile(r"timeout|AbortSignal|signal\s*:", re.I)
SQL_SELECT = re.compile(r"\bselect\b[^;\"'`]{0,200}\bfrom\b", re.I)
REST_SELECT = re.compile(r"[?&]select=")
BOUND = re.compile(r"\blimit\b|[?&]limit=|\.limit\(|\btop\s+\d|\bfetch\s+first|\.range\(|=eq\.|\bwhere\b[^;]*\bid\s*=", re.I)
SERVER_PATH = re.compile(r"(^|/)(api|server|routes?|handlers?|controllers?|services?)/|(^|/)(app|server|main|index)\.(py|js|ts|mjs)$")
MODULE_STATE = re.compile(r"^(let|var)\s+\w+\s*=|^(const)\s+\w*(cache|store|sessions?|state|memo)\w*\s*=\s*(new\s+Map|\{|\[)|^\w*(cache|store|sessions?|state|memo)\w*\s*(:\s*[\w\[\], |]+)?=\s*(\{\}|\[\]|dict\(\)|set\(\))", re.I)
LOCAL_WRITE = re.compile(r"\bwriteFile(Sync)?\(|\bappendFile(Sync)?\(|open\([^)]*[\"'][wa]b?[\"']")
DEPLOY_SIGNALS = {
    "container": (r"(^|/)Dockerfile[\w.-]*$|(^|/)Containerfile$", 25),
    "orchestration": (r"(^|/)(docker-)?compose\.ya?ml$|(^|/)(k8s|kubernetes|helm|charts)/|(^|/)(vercel|netlify)\.json$|(^|/)fly\.toml$|(^|/)Procfile$|(^|/)render\.yaml$|(^|/)app\.yaml$|\.tf$", 25),
    "env_template": (r"(^|/)\.env\.(example|sample|template)$|(^|/)example\.env$", 20),
    "ci": (r"^\.github/workflows/|^\.gitlab-ci\.yml$|^\.circleci/", 15),
}


def analyze_repository(root: Path) -> dict:
    files = source_files(root)
    if not files:
        raise ValueError("No supported source files were found to evaluate.")
    findings: list[tuple[int, dict]] = []
    hardcoded_files = env_files = 0
    calls = calls_with_timeout = queries = bounded = 0
    server_files = stateful_files = 0
    health_endpoint = False
    for source in files:
        text, lines = source.text, source.lines
        if ENV_USE.search(text):
            env_files += 1
        if re.search(r"[\"'`/]health(z|check)?[\"'`]", text):
            health_endpoint = True
        has_hardcoded = False
        for number, line in enumerate(lines, start=1):
            if line.strip().startswith(("#", "//", "*")):
                continue
            if HARDCODED_HOST.search(line) and not ENV_USE.search(line):
                has_hardcoded = True
                findings.append((2, fix("Hard-coded local address", f"{source.rel}:{number}", "Read the host and port from an environment variable.")))
            if NETWORK_CALL.search(line):
                calls += 1
                window = "\n".join(lines[number - 1:number + 6])
                if TIMEOUT.search(window):
                    calls_with_timeout += 1
                else:
                    findings.append((3, fix("Network call without a timeout", f"{source.rel}:{number}", "A slow dependency will hold the request open; add a timeout or AbortSignal.")))
            if SQL_SELECT.search(line) or REST_SELECT.search(line):
                queries += 1
                if BOUND.search(line):
                    bounded += 1
                else:
                    findings.append((2, fix("Unbounded query", f"{source.rel}:{number}", "Add a LIMIT or pagination so results cannot grow without bound.")))
        hardcoded_files += has_hardcoded
        if SERVER_PATH.search(source.rel):
            server_files += 1
            stateful = [number for number, line in enumerate(lines, start=1) if MODULE_STATE.search(line) or LOCAL_WRITE.search(line)]
            if stateful:
                stateful_files += 1
                findings.append((2, fix("In-memory or local-disk state in server code", f"{source.rel}:{stateful[0]}", "State kept in one instance is lost or inconsistent when you run several; use a database or cache service.")))

    paths = list(walk_files(root))
    deploy_score, deploy_found = 0, []
    for name, (pattern, points) in DEPLOY_SIGNALS.items():
        if any(re.search(pattern, path) for path in paths):
            deploy_score += points
            deploy_found.append(name)
    if health_endpoint:
        deploy_score += 15
        deploy_found.append("health endpoint")
    if deploy_score < 60:
        findings.append((1, fix("Limited deployment setup", "", "Add a container or platform config, an .env example, CI, and a /health endpoint.")))

    config_score = ramp(hardcoded_files / len(files), 0.15, 0.0) * (1.0 if env_files else 0.7)
    categories = {
        "config_externalized": {"score": config_score, "detail": f"{hardcoded_files} files hard-code local hosts; {env_files} read configuration from the environment."},
        "network_resilience": {"score": 100.0 if not calls else calls_with_timeout / calls * 100, "detail": f"{calls_with_timeout} of {calls} network calls set a timeout."},
        "bounded_queries": {"score": 100.0 if not queries else bounded / queries * 100, "detail": f"{bounded} of {queries} queries are limited or keyed."},
        "stateless_design": {"score": 100.0 if not server_files else ramp(stateful_files / server_files, 0.4, 0.0), "detail": f"{stateful_files} of {server_files} server files keep module-level state or write to local disk."},
        "deployment_readiness": {"score": min(100.0, deploy_score), "detail": "Found: " + (", ".join(deploy_found) or "nothing") + "."},
    }
    findings.sort(key=lambda item: -item[0])
    return build_report("scalability", VERSION, root, categories, WEIGHTS, LABELS, INTERPRETATIONS,
                        [item for _, item in findings], {"files": len(files), "network_calls": calls, "queries": queries})


if __name__ == "__main__":
    raise SystemExit(run_cli(__doc__, "scalability_report.json", "Scalability", analyze_repository))
