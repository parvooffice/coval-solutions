"""Vercel Python function that runs COVAL's six code-review agents in the cloud.

POST /api/code-evaluation-python with header `x-coval-evaluation-secret` and body
{"urls": ["https://github.com/owner/repo", ...]} (1-5 public GitHub repositories).
Agents: Documentation, Modularity, Security, Error handling, Readability, Test coverage.
"""

from __future__ import annotations

import hmac
import json
import os
import runpy
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "run-code-evaluation.py"
MAX_BODY_BYTES = 16_384


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        expected = os.environ.get("CODE_EVALUATION_FUNCTION_SECRET", "").strip()
        supplied = self.headers.get("x-coval-evaluation-secret", "").strip()
        if not expected:
            self._respond(503, {"error": "The analyzer service is missing its internal secret configuration."})
            return
        if not supplied or not hmac.compare_digest(supplied, expected):
            self._respond(401, {"error": "Unauthorized analyzer request."})
            return

        try:
            content_length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._respond(400, {"error": "Invalid request length."})
            return
        if content_length < 1 or content_length > MAX_BODY_BYTES:
            self._respond(413 if content_length > MAX_BODY_BYTES else 400, {"error": "Keep each evaluation request under 16 KB."})
            return

        try:
            body = json.loads(self.rfile.read(content_length))
            urls = body.get("urls") if isinstance(body, dict) else None
            if not isinstance(urls, list):
                raise ValueError("Submit repository URLs as a JSON array.")
            if not 1 <= len(urls) <= 5:
                raise ValueError("Evaluate between one and five repositories per run.")

            namespace = runpy.run_path(str(RUNNER))
            report = namespace["run_remote_targets"](urls)
            self._respond(200, {"report": report})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._respond(400, {"error": "Request body must be valid JSON."})
        except ValueError as error:
            self._respond(400, {"error": str(error)})
        except RuntimeError as error:
            self._respond(502, {"error": str(error)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": "The analyzers could not complete this run. Check the Vercel function logs."})

    def do_GET(self) -> None:
        self._respond(405, {"error": "Use POST to submit repository URLs."})

    def _respond(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)
