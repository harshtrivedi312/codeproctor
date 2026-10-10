"""FastAPI app of the analysis worker (ADR 0014).

A stateless internal compute service. Every route except `GET /health` needs a signed request
(signing.py, `WORKER_HMAC_KEYS`); the old static `X-Internal-Token` and the unversioned `/analyze/*`
and `/risk` routes are gone (ADR 0014 4.3: `WORKER_INTERNAL_TOKEN` is removed). Interactive docs
exist only when `WORKER_ENV=local`. Request bodies hold candidate code, so nothing here logs them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from worker.config import ReviewPathConfig
from worker.org_settings import install_org_settings_handler
from worker.routes_analyze import (
    BODY_LIMITS,
    AudioProvider,
    install_analyze_routes,
)
from worker.routes_face import FaceRuntime, install_face_routes
from worker.vad import VadBackend


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Validate system config once at startup: a bad value stops the deploy, not the requests."""
    ReviewPathConfig.from_env()  # RISK_FAST_REVIEW_BANDS
    yield


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

    # Signing (every route but GET /health), /v1 errors and the face routes, with the per-route
    # body limits of the analysis routes.
    install_face_routes(app, runtime, keys=keys, docs_local=docs_local, body_limits=BODY_LIMITS)
    install_org_settings_handler(app)
    install_analyze_routes(app, audio=audio, vad_backend=vad_backend)
    return app


app = create_app()
