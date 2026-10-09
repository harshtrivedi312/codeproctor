"""FastAPI app of the analysis worker (ADR 0014).

A stateless internal compute service. Every route except `GET /health` needs a signed request
(signing.py, `WORKER_HMAC_KEYS`); the old static `X-Internal-Token` and the unversioned `/analyze/*`
and `/risk` routes are gone (ADR 0014 4.3: `WORKER_INTERNAL_TOKEN` is removed). Interactive docs
exist only when `WORKER_ENV=local`. Request bodies hold candidate code, so nothing here logs them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, cast

from fastapi import FastAPI
from starlette.middleware import Middleware

from worker.config import ReviewPathConfig
from worker.org_settings import install_org_settings_handler
from worker.routes_analyze import (
    BODY_LIMITS,
    AudioProvider,
    install_analyze_routes,
)
from worker.routes_face import FaceRuntime, install_face_routes
from worker.signing import SigningMiddleware
from worker.vad import VadBackend

# The only unsigned route (ADR 0014 4.2). The signing default also exempts the legacy paths.
UNSIGNED_PATHS = frozenset({"/health"})


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Validate system config once at startup: a bad value stops the deploy, not the requests."""
    ReviewPathConfig.from_env()  # RISK_FAST_REVIEW_BANDS
    yield


def _configure_signing(app: FastAPI) -> None:
    """Tighten the signing middleware that `install_face_routes` adds with its defaults.

    It covers every route except `/health` (the defaults also left `/risk` and `/analyze/` open for
    the legacy token routes) and applies the per-route body limits. Done here, on the middleware's
    options, so signing.py and routes_face.py stay unchanged.
    """
    for i, mw in enumerate(app.user_middleware):
        if cast(object, mw.cls) is SigningMiddleware:
            options: dict[str, Any] = {
                **mw.kwargs,
                "body_limits": BODY_LIMITS,
                "unsigned_paths": UNSIGNED_PATHS,
                "unsigned_prefixes": (),
            }
            app.user_middleware[i] = Middleware(SigningMiddleware, **options)
            return
    raise RuntimeError("signing middleware is not installed")


def create_app(
    runtime: FaceRuntime | None = None,
    *,
    keys: dict[str, bytes] | None = None,
    docs_local: bool = False,
    audio: AudioProvider | None = None,
    vad_backend: Callable[[], VadBackend] | None = None,
) -> FastAPI:
    """Build the app. With no arguments the system configuration comes from the environment."""
    app = FastAPI(title="CodeProctor analysis worker", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    install_face_routes(app, runtime, keys=keys, docs_local=docs_local)  # signing + /v1 errors
    install_org_settings_handler(app)
    install_analyze_routes(app, audio=audio, vad_backend=vad_backend)
    _configure_signing(app)
    return app


app = create_app()
