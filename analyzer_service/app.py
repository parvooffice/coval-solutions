"""Authenticated HTTP wrapper around COVAL's Python repository scorers."""

from __future__ import annotations

import hmac
import json
import os
import runpy
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "run-code-evaluation.py"
MAX_BODY_BYTES = 16_384
app = FastAPI(title="COVAL Python Analyzer", docs_url=None, redoc_url=None)
runner: dict[str, Any] | None = None


class AnalyzeRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=5)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/code-evaluation-python")
def evaluate(payload: AnalyzeRequest, x_coval_evaluation_secret: str = Header(default="")) -> dict[str, Any]:
    expected = os.environ.get("CODE_EVALUATION_FUNCTION_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="The analyzer is missing its internal secret configuration.")
    if not x_coval_evaluation_secret or not hmac.compare_digest(expected, x_coval_evaluation_secret.strip()):
        raise HTTPException(status_code=401, detail="Unauthorized analyzer request.")
    if len(json.dumps(payload.model_dump()).encode("utf-8")) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Keep each evaluation request under 16 KB.")
    if any(not url.startswith("https://github.com/") for url in payload.urls):
        raise HTTPException(status_code=400, detail="Submit public GitHub repository URLs.")
    global runner
    try:
        if runner is None:
            runner = runpy.run_path(str(RUNNER))
        report = runner["run_remote_targets"](payload.urls)
        return {"report": report}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail="The repository analyzers could not complete this run.") from error
