from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, StateGraph

from .models import Finding, RepositoryMetadata, SecurityReport
from .reporting import build_report, save_report
from .scanners import build_scanner_plan, external_tool_scan, heuristic_scan
from .workspace import clone_repository, collect_repository_metadata, cleanup_directory, normalize_repo_reference


class AuditState(TypedDict):
    repo_reference: str
    repo_path: str
    metadata: RepositoryMetadata
    scanner_plan: list[str]
    findings: list[Finding]
    report: SecurityReport
    report_path: str
    output_dir: str
    cleanup_path: str
    errors: list[str]


def validate_repository_node(state: AuditState) -> AuditState:
    repo_reference = normalize_repo_reference(state["repo_reference"])
    state["repo_reference"] = repo_reference
    return state


def clone_repository_node(state: AuditState) -> AuditState:
    clone_path = clone_repository(state["repo_reference"], destination_root=None)
    state["repo_path"] = clone_path
    state["cleanup_path"] = clone_path
    return state


def discover_repository_node(state: AuditState) -> AuditState:
    metadata = collect_repository_metadata(state["repo_path"])
    state["metadata"] = metadata
    return state


def select_scanners_node(state: AuditState) -> AuditState:
    state["scanner_plan"] = build_scanner_plan(state["metadata"])
    return state


def run_analysis_node(state: AuditState) -> AuditState:
    findings: list[Finding] = []
    findings.extend(heuristic_scan(state["repo_path"], state["metadata"]))
    findings.extend(external_tool_scan(state["repo_path"], state["metadata"]))
    unique: dict[str, Finding] = {}
    for finding in findings:
        unique[finding.id] = finding
    state["findings"] = list(unique.values())
    return state


def generate_report_node(state: AuditState) -> AuditState:
    report = build_report(state["metadata"], state["findings"], state["scanner_plan"])
    state["report"] = report
    return state


def save_report_node(state: AuditState) -> AuditState:
    report_path = save_report(state["report"], state["output_dir"])
    state["report_path"] = report_path
    return state


def cleanup_node(state: AuditState) -> AuditState:
    cleanup_directory(state["cleanup_path"])
    return state


def build_graph() -> StateGraph:
    graph = StateGraph(AuditState)
    graph.add_node("validate_repository", validate_repository_node)
    graph.add_node("clone_repository", clone_repository_node)
    graph.add_node("discover_repository", discover_repository_node)
    graph.add_node("select_scanners", select_scanners_node)
    graph.add_node("run_analysis", run_analysis_node)
    graph.add_node("generate_report", generate_report_node)
    graph.add_node("save_report", save_report_node)
    graph.add_node("cleanup", cleanup_node)

    graph.set_entry_point("validate_repository")
    graph.add_edge("validate_repository", "clone_repository")
    graph.add_edge("clone_repository", "discover_repository")
    graph.add_edge("discover_repository", "select_scanners")
    graph.add_edge("select_scanners", "run_analysis")
    graph.add_edge("run_analysis", "generate_report")
    graph.add_edge("generate_report", "save_report")
    graph.add_edge("save_report", "cleanup")
    graph.add_edge("cleanup", END)
    return graph.compile()


def run_repository_audit(repo_reference: str, output_dir: str = "reports") -> SecurityReport:
    workflow = build_graph()
    initial_state: AuditState = {
        "repo_reference": repo_reference,
        "repo_path": "",
        "metadata": RepositoryMetadata(repo_name="pending", repo_url="", clone_path="", languages=[], frameworks=[], package_managers=[], dependency_files=[], config_files=[], ci_cd_files=[], docker_files=[], tests_present=False),
        "scanner_plan": [],
        "findings": [],
        "report": None,
        "report_path": "",
        "output_dir": output_dir,
        "cleanup_path": "",
        "errors": [],
    }
    result = workflow.invoke(initial_state)
    return result["report"]
