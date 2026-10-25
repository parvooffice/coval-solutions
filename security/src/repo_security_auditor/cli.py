from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel

from .graph import run_repository_audit

app = typer.Typer(help="Autonomous repository security auditor")
console = Console()


@app.callback(invoke_without_command=True)
def main(
    repo_url: str | None = typer.Argument(None),
    output_dir: Path = typer.Option(Path("reports"), "--output-dir", "-o", help="Directory for JSON reports."),
    api: bool = typer.Option(False, "--api", help="Run the FastAPI server instead of the CLI workflow."),
    host: str = typer.Option("127.0.0.1", "--host", help="Address to bind the FastAPI server to."),
    port: int = typer.Option(8000, "--port", help="Port for the FastAPI server."),
):
    if api:
        import uvicorn
        from .api import create_app

        console.print(Panel("Starting FastAPI repository auditor API", title="API"))
        uvicorn.run(create_app(), host=host, port=port)
        raise typer.Exit()

    if repo_url is None:
        console.print(Panel("Autonomous Repository Security Auditor", title="Repository Security Audit"))
        if typer.confirm("Do you want to analyze a repository?", default=True):
            repo_url = typer.prompt("Enter repository URL or local path")
        else:
            raise typer.Exit()

    console.print(f"[cyan]Analyzing repository:[/] {repo_url}")
    report = run_repository_audit(repo_url, output_dir=str(output_dir))
    console.print(Panel(f"Overall Security Score: {report.overall_score} / 100\nSeverity Summary: {report.severity_summary}", title="Analysis Complete"))
    report_path = str(output_dir / f"{report.repo_name}-security-report.json")
    console.print(f"[green]Report saved to:[/] {report_path}")
    console.print("[green]Temporary repository cleanup is handled automatically by the workflow.[/]")


if __name__ == "__main__":
    app()
