from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from .graph import run_repository_audit


class AnalyzeRequest(BaseModel):
    repo_url: str
    output_dir: str = "reports"


class AnalyzeResponse(BaseModel):
    success: bool
    report_path: str | None = None
    overall_score: float | None = None
    findings_count: int = 0
    message: str


def create_app() -> FastAPI:
    app = FastAPI(title="Repository Security Auditor API", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/analyze", response_model=AnalyzeResponse)
    def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
        try:
            report = run_repository_audit(payload.repo_url, output_dir=payload.output_dir)
            output_path = str(payload.output_dir) + "/" + f"{report.repo_name}-security-report.json"
            return AnalyzeResponse(
                success=True,
                report_path=output_path,
                overall_score=report.overall_score,
                findings_count=len(report.findings),
                message="Repository analysis completed.",
            )
        except Exception as exc:  # pragma: no cover - API error path
            return AnalyzeResponse(
                success=False,
                message=f"Analysis failed: {exc}",
            )

    return app
