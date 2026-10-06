"""RFC 7807 errors for /v1 routes (ADR 0014 6.1, 6.4). A 400 never echoes input."""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

V1_PREFIX = "/v1/"


def problem_body(status: int, code: str, title: str) -> bytes:
    return json.dumps(
        {"type": "about:blank", "title": title, "status": status, "code": code},
        separators=(",", ":"),
    ).encode()


def problem(status: int, code: str, title: str, headers: dict[str, str] | None = None) -> Response:
    return Response(
        problem_body(status, code, title),
        status_code=status,
        media_type="application/problem+json",
        headers=headers,
    )


def install_problem_handlers(app: FastAPI) -> None:
    """Fixed-code errors on /v1 paths; other paths keep FastAPI defaults until BE-12 moves them."""

    async def on_validation(request: Request, exc: RequestValidationError) -> Response:
        if not request.url.path.startswith(V1_PREFIX):
            return await request_validation_exception_handler(request, exc)
        # Field paths only: `loc` never holds a value, `msg` and `input` are dropped.
        paths = [".".join(str(p) for p in e["loc"] if p != "body") for e in exc.errors()]
        body: dict[str, Any] = {
            "type": "about:blank",
            "title": "Validation failed",
            "status": 400,
            "code": "VALIDATION_FAILED",
            "fields": paths[:20],
        }
        return JSONResponse(body, status_code=400, media_type="application/problem+json")

    async def on_unexpected(request: Request, exc: Exception) -> Response:
        if not request.url.path.startswith(V1_PREFIX):
            return JSONResponse({"detail": "Internal Server Error"}, status_code=500)
        return problem(500, "INTERNAL", "Internal error")

    app.add_exception_handler(RequestValidationError, on_validation)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, on_unexpected)
