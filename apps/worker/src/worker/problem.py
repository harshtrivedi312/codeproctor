"""RFC 7807 errors for /v1 routes (ADR 0014 6.1, 6.4). A 400 never echoes input."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

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


def _safe_path(error: Mapping[str, object]) -> str:
    loc = [str(p) for p in error["loc"] if p != "body"]  # type: ignore[attr-defined]
    if not loc or (error["type"] == "extra_forbidden" and len(loc) == 1):
        return "*"  # the unknown key is the caller's own text
    return loc[0] + (".*" if len(loc) > 1 else "")


def install_problem_handlers(app: FastAPI) -> None:
    """Fixed-code errors on /v1 paths; other paths keep FastAPI defaults until BE-12 moves them."""

    async def on_validation(request: Request, exc: RequestValidationError) -> Response:
        if not request.url.path.startswith(V1_PREFIX):
            return await request_validation_exception_handler(request, exc)
        # Only the declared top-level field, and ".*" when the error is deeper. Nested keys can be
        # chosen by the caller (starterCode, config), so they are never echoed (ADR 0014 6.1).
        paths = sorted({_safe_path(e) for e in exc.errors()})
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

    async def on_http(request: Request, exc: StarletteHTTPException) -> Response:
        if not request.url.path.startswith(V1_PREFIX):
            return await http_exception_handler(request, exc)
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        return problem(exc.status_code, codes.get(exc.status_code, "HTTP_ERROR"), "Request refused")

    app.add_exception_handler(RequestValidationError, on_validation)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, on_http)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, on_unexpected)
