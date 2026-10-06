"""Face routes for the identity check (ADR 0014 6.2; FR-403, FR-606, TC-033).

The API calls these with signed requests and presigned URLs. The worker fetches the images, runs
the matcher and answers; it keeps nothing by default (`cacheSelfie: false`). Every face outcome is
a 200 with MATCH or MANUAL_REVIEW: an unreadable image, a missing model or a failed download is
MANUAL_REVIEW / MATCH_ERROR, never a failure of the candidate and never a rejection (D-05). Only
a refused URL (a request bug) is a 400, and a busy worker a 503. Scores, URLs, session ids and
images are never logged; one fixed-code line per call is.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from importlib import metadata
from pathlib import Path
from typing import Annotated, Final, Literal

from fastapi import APIRouter, FastAPI, Request, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, model_validator

from worker import fetchguard
from worker.config import FaceConfig
from worker.face.embedding import MODEL_ID
from worker.face.imagepolicy import ImagePolicyError, Role, check_image
from worker.face.matcher import FaceMatcher, review_for_model_error
from worker.face.modelfile import ModelLoadError
from worker.face.types import FaceDecision, MatchResult, ReviewReason
from worker.modellock import LoadedLock, ModelCheck, ModelLockError, check_models, load_lock
from worker.problem import install_problem_handlers, problem
from worker.signing import KeyConfigError, SigningMiddleware, parse_keys

log = logging.getLogger(__name__)
FACE_CONCURRENCY: Final = 4
RETRY_AFTER_SECONDS: Final = "5"
STRICT_ENVS: Final = frozenset({"staging", "pilot", "production"})
KNOWN_ENVS: Final = STRICT_ENVS | {"", "local"}
CACHE_FORBIDDEN_ENVS: Final = frozenset({"pilot", "production"})  # ADR 0004 question 1 is open
MAX_CACHE_TTL: Final = timedelta(hours=4)  # ADR 0014 6.3 backstop
DEFAULT_LOCK_PATH: Final = Path(__file__).resolve().parents[2] / "models.lock.json"
_SESSION_ID = r"^[A-Za-z0-9_-]{1,64}$"


class _Req(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)


class MatchRequest(_Req):
    sessionId: Annotated[str, Field(pattern=_SESSION_ID)]  # noqa: N815 - wire name
    attempt: Annotated[int, Field(ge=1, le=2)]
    idImageUrl: Annotated[str, Field(min_length=1, max_length=fetchguard.MAX_URL_LENGTH)]  # noqa: N815
    selfieUrl: Annotated[str, Field(min_length=1, max_length=fetchguard.MAX_URL_LENGTH)]  # noqa: N815
    livenessConfirmed: StrictBool  # noqa: N815
    cacheSelfie: StrictBool = False  # noqa: N815
    cacheExpiresAt: AwareDatetime | None = None  # noqa: N815

    @model_validator(mode="after")
    def _expiry(self) -> MatchRequest:
        if self.cacheSelfie != (self.cacheExpiresAt is not None):
            raise ValueError("cacheExpiresAt is required exactly when cacheSelfie is true")
        if self.cacheExpiresAt is not None and self.cacheExpiresAt <= datetime.now(UTC):
            raise ValueError("cacheExpiresAt is in the past")
        return self


class RecheckRequest(_Req):
    sessionId: Annotated[str, Field(pattern=_SESSION_ID)]  # noqa: N815
    frameUrl: Annotated[str, Field(min_length=1, max_length=fetchguard.MAX_URL_LENGTH)]  # noqa: N815
    selfieUrl: Annotated[str, Field(min_length=1, max_length=fetchguard.MAX_URL_LENGTH)]  # noqa: N815
    cacheSelfie: StrictBool = False  # noqa: N815
    cacheExpiresAt: AwareDatetime | None = None  # noqa: N815

    @model_validator(mode="after")
    def _expiry(self) -> RecheckRequest:
        if self.cacheSelfie != (self.cacheExpiresAt is not None):
            raise ValueError("cacheExpiresAt is required exactly when cacheSelfie is true")
        if self.cacheExpiresAt is not None and self.cacheExpiresAt <= datetime.now(UTC):
            raise ValueError("cacheExpiresAt is in the past")
        return self


class EvictRequest(_Req):
    sessionId: Annotated[str, Field(pattern=_SESSION_ID)]  # noqa: N815


class MatchResponse(BaseModel):
    decision: FaceDecision
    reason: ReviewReason | None
    detail: str | None
    score: float | None
    modelId: str  # noqa: N815
    threshold: float
    workerVersion: str  # noqa: N815
    lockDigest: str  # noqa: N815


RecheckOutcome = Literal["MATCH", "BELOW_THRESHOLD", "NO_FACE", "MULTIPLE_FACES", "ERROR"]


class RecheckResponse(BaseModel):
    outcome: RecheckOutcome
    score: float | None
    modelId: str  # noqa: N815
    threshold: float
    cache: Literal["HIT", "MISS", "OFF"]
    workerVersion: str  # noqa: N815
    lockDigest: str  # noqa: N815


@dataclass
class FaceRuntime:
    """Everything the routes need, held on `app.state` (never in a module global)."""

    face_config: FaceConfig
    loaded_lock: LoadedLock | None
    check: ModelCheck | None
    fetch: fetchguard.FetchConfig | None
    cache_enabled: bool = False
    worker_version: str = "0.0.0"
    matcher_factory: Callable[[], FaceMatcher] | None = None  # injectable for tests
    semaphore: threading.BoundedSemaphore = field(
        default_factory=lambda: threading.BoundedSemaphore(FACE_CONCURRENCY)
    )
    _matcher: FaceMatcher | None = field(default=None, init=False, repr=False)
    _error: ModelLoadError | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    @property
    def lock_digest(self) -> str:
        return self.loaded_lock.digest12 if self.loaded_lock else "000000000000"

    def built_matcher(self) -> FaceMatcher | None:
        with self._lock:
            return self._matcher

    def matcher(self) -> tuple[FaceMatcher | None, ModelLoadError | None]:
        """Build once. A model that fails its pin stays failed until the worker restarts."""
        with self._lock:
            if self._matcher is None and self._error is None:
                try:
                    factory = self.matcher_factory
                    if factory is None:
                        from worker.face.factory import build_face_matcher

                        self._matcher = build_face_matcher(self.face_config)
                    else:
                        self._matcher = factory()
                except ModelLoadError as e:
                    self._error = e
                except Exception:  # noqa: BLE001 - e.g. mediapipe missing: same outcome
                    self._error = ModelLoadError("MODEL_UNAVAILABLE")
            return self._matcher, self._error


router = APIRouter(prefix="/v1")


def _expiry(value: datetime | None) -> float | None:
    """Epoch seconds, never later than now + 4 h (the ADR 0014 6.3 backstop)."""
    if value is None:
        return None
    return min(value, datetime.now(UTC) + MAX_CACHE_TTL).timestamp()


def _runtime(request: Request) -> FaceRuntime:
    rt: FaceRuntime = request.app.state.face_runtime
    return rt


def _review(rt: FaceRuntime, detail: str) -> MatchResult:
    return MatchResult(
        FaceDecision.MANUAL_REVIEW,
        ReviewReason.MATCH_ERROR,
        detail,
        None,
        MODEL_ID,
        rt.face_config.match_threshold,
    )


def _match_body(rt: FaceRuntime, r: MatchResult) -> MatchResponse:
    return MatchResponse(
        decision=r.decision,
        reason=r.reason,
        detail=r.detail,
        score=r.score,
        modelId=r.model_id,
        threshold=r.threshold,
        workerVersion=rt.worker_version,
        lockDigest=rt.lock_digest,
    )


def _busy() -> Response:
    return problem(503, "WORKER_BUSY", "Worker busy", {"Retry-After": RETRY_AFTER_SECONDS})


def _not_configured() -> Response:
    return problem(503, "WORKER_NOT_CONFIGURED", "Worker not configured")


def _get(rt: FaceRuntime, url: str, role: Role) -> bytes:
    """Download and apply the role's caps. FetchError(URL_REFUSED) is the caller's bug (400); the
    rest become MANUAL_REVIEW codes through ImagePolicyError / FetchError handling in the routes."""
    if rt.fetch is None:  # callers check first; never rely on `assert`
        raise fetchguard.FetchError("MEDIA_UNAVAILABLE")
    from worker.face.imagepolicy import POLICIES

    data = fetchguard.fetch(
        url,
        rt.fetch,
        max_bytes=POLICIES[role].max_bytes,
        max_lifetime=fetchguard.FACE_MAX_URL_LIFETIME,
        timeout=10.0,
    )
    check_image(role, data)
    return data


@router.get("/ready")
def ready(request: Request) -> Response:
    rt = _runtime(request)
    if rt.check is None or not rt.check.ready:
        return problem(503, "MODEL_UNAVAILABLE", "Models unavailable")
    matcher, error = rt.matcher()
    if matcher is None or error is not None:
        return problem(503, "MODEL_UNAVAILABLE", "Models unavailable")
    return Response(
        _json(
            {
                "ready": True,
                "workerVersion": rt.worker_version,
                "lockDigest": rt.lock_digest,
                "models": [{"component": c, "modelId": n} for c, n in rt.check.models],
            }
        ),
        media_type="application/json",
    )


def _json(data: object) -> bytes:
    import json

    return json.dumps(data, separators=(",", ":")).encode()


@router.post("/face/match", response_model=MatchResponse)
def match(body: MatchRequest, request: Request) -> MatchResponse | Response:
    rt = _runtime(request)
    if rt.fetch is None:
        log.warning("face route=match outcome=WORKER_NOT_CONFIGURED")
        return _not_configured()
    if not rt.semaphore.acquire(blocking=False):
        log.warning("face route=match outcome=WORKER_BUSY")
        return _busy()
    try:
        matcher, error = rt.matcher()
        if matcher is None:
            result = review_for_model_error(
                error or ModelLoadError("MODEL_UNAVAILABLE"), rt.face_config
            )
            log.info("face route=match outcome=%s", result.detail)
            return _match_body(rt, result)
        if not body.livenessConfirmed:  # fail closed before downloading any biometric image
            result = MatchResult(
                FaceDecision.MANUAL_REVIEW,
                ReviewReason.LIVENESS_NOT_CONFIRMED,
                "LIVENESS",
                None,
                matcher.model_id,
                rt.face_config.match_threshold,
            )
            log.info("face route=match outcome=%s", result.decision.value)
            return _match_body(rt, result)
        try:
            id_image = _get(rt, body.idImageUrl, "ID")
            selfie = _get(rt, body.selfieUrl, "SELFIE")
        except fetchguard.FetchError as e:
            if e.code == "URL_REFUSED":
                log.warning("face route=match outcome=URL_REFUSED")  # alert (ADR 0014 4.5)
                return problem(400, "VALIDATION_FAILED", "Request refused")
            result = _review(rt, e.code)
        except ImagePolicyError as e:
            result = _review(rt, e.code)
        else:
            cache_key = body.sessionId if body.cacheSelfie and rt.cache_enabled else None
            result = matcher.match(
                id_image,
                selfie,
                liveness_confirmed=body.livenessConfirmed,
                session_id=cache_key,
                expires_at=_expiry(body.cacheExpiresAt),
            )
        log.info("face route=match outcome=%s", result.decision.value)
        return _match_body(rt, result)
    finally:
        rt.semaphore.release()


def _outcome(r: MatchResult) -> RecheckOutcome:
    """ADR 0014 6.2: MATCH, or a frame problem maps to itself; a selfie problem is an ERROR."""
    if r.decision is FaceDecision.MATCH:
        return "MATCH"
    if r.detail is not None and r.detail.startswith("SELFIE_"):
        return "ERROR"
    if r.reason is ReviewReason.BELOW_THRESHOLD:
        return "BELOW_THRESHOLD"
    if r.reason is ReviewReason.NO_FACE:
        return "NO_FACE"
    if r.reason is ReviewReason.MULTIPLE_FACES:
        return "MULTIPLE_FACES"
    return "ERROR"


def _recheck_body(
    rt: FaceRuntime, r: MatchResult, cache: Literal["HIT", "MISS", "OFF"]
) -> RecheckResponse:
    return RecheckResponse(
        outcome=_outcome(r),
        score=r.score,
        modelId=r.model_id,
        threshold=r.threshold,
        cache=cache,
        workerVersion=rt.worker_version,
        lockDigest=rt.lock_digest,
    )


@router.post("/face/recheck", response_model=RecheckResponse)
def recheck(body: RecheckRequest, request: Request) -> RecheckResponse | Response:
    rt = _runtime(request)
    if rt.fetch is None:
        log.warning("face route=recheck outcome=WORKER_NOT_CONFIGURED")
        return _not_configured()
    if not rt.semaphore.acquire(blocking=False):
        log.warning("face route=recheck outcome=WORKER_BUSY")
        return _busy()
    try:
        matcher, error = rt.matcher()
        if matcher is None:
            failed = review_for_model_error(
                error or ModelLoadError("MODEL_UNAVAILABLE"), rt.face_config
            )
            return _recheck_body(rt, failed, "OFF")
        cache_mode: Literal["HIT", "MISS", "OFF"] = "OFF"
        try:
            frame = _get(rt, body.frameUrl, "FRAME")
            if body.cacheSelfie and rt.cache_enabled:
                if matcher.selfie_cache.get(body.sessionId) is not None:
                    cache_mode = "HIT"
                else:
                    cache_mode = "MISS"
                    selfie = _get(rt, body.selfieUrl, "SELFIE")
                    primed = matcher.prime_selfie(
                        body.sessionId, selfie, _expiry(body.cacheExpiresAt)
                    )
                    if primed is not None:
                        return _recheck_body(rt, primed, cache_mode)
                result = matcher.recheck(body.sessionId, frame)
            else:
                selfie = _get(rt, body.selfieUrl, "SELFIE")
                result = matcher.recheck_with_selfie(frame, selfie)
        except fetchguard.FetchError as e:
            if e.code == "URL_REFUSED":
                log.warning("face route=recheck outcome=URL_REFUSED")
                return problem(400, "VALIDATION_FAILED", "Request refused")
            result = _review(rt, e.code)
        except ImagePolicyError as e:
            result = _review(rt, e.code)
        out = _recheck_body(rt, result, cache_mode)
        log.info("face route=recheck outcome=%s cache=%s", out.outcome, cache_mode)
        return out
    finally:
        rt.semaphore.release()


@router.post("/face/evict", status_code=204)
def evict(body: EvictRequest, request: Request) -> Response:
    rt = _runtime(request)
    matcher = rt.built_matcher()  # never loads a model just to evict
    if matcher is not None:
        matcher.end_session(body.sessionId)
    return Response(status_code=204)


def build_runtime(
    environ: dict[str, str] | os._Environ[str] | None = None,
) -> tuple[FaceRuntime, dict[str, bytes], bool]:
    """Read system configuration. In staging, pilot and production (`WORKER_ENV`) a missing key,
    a missing models directory or any bad model file refuses to start. With `WORKER_ENV` unset
    (tests, tooling) those checks are skipped and the routes report not ready instead."""
    env = os.environ if environ is None else environ
    mode = env.get("WORKER_ENV", "")
    if mode not in KNOWN_ENVS:  # a typo must not silently run lenient
        raise ValueError("unknown WORKER_ENV")
    strict = mode in STRICT_ENVS
    cache_flag = env.get("WORKER_FACE_CACHE_ENABLED", "false") == "true"
    if cache_flag and mode in CACHE_FORBIDDEN_ENVS:
        raise ValueError("selfie cache is not allowed here until ADR 0004 question 1 is answered")
    keys = parse_keys(env.get("WORKER_HMAC_KEYS", ""))
    if strict and not keys:
        raise KeyConfigError("NO_KEYS")
    loaded = load_lock(Path(env.get("WORKER_MODELS_LOCK", str(DEFAULT_LOCK_PATH))))
    models_dir = env.get("WORKER_MODELS_DIR", "/models" if strict else "")
    check: ModelCheck | None = None
    if models_dir:
        check = check_models(loaded, Path(models_dir))  # raises ModelLockError: refuse to start
    elif strict:
        raise ModelLockError("MODELS_DIR_MISSING")
    fetch = None
    origins, bucket = (
        env.get("WORKER_OBJECT_STORE_ORIGINS", ""),
        env.get("WORKER_OBJECT_STORE_BUCKET", ""),
    )
    if origins and bucket:
        fetch = fetchguard.build_config(origins, bucket, allow_http=mode == "local")
    elif strict:
        raise ValueError("object store not configured")
    try:
        version = metadata.version("codeproctor-worker")
    except metadata.PackageNotFoundError:
        version = "0.0.0"
    rt = FaceRuntime(
        face_config=FaceConfig.from_env(),
        loaded_lock=loaded,
        check=check,
        fetch=fetch,
        cache_enabled=cache_flag,  # off by default
        worker_version=version,
    )
    return rt, keys, mode == "local"


def install_face_routes(
    app: FastAPI,
    runtime: FaceRuntime | None = None,
    *,
    keys: dict[str, bytes] | None = None,
    docs_local: bool = False,
) -> None:
    """Wire signing, /v1 errors and the face routes into `app` (one call from app.py)."""
    if runtime is None:
        runtime, keys, docs_local = build_runtime()
    app.state.face_runtime = runtime
    if not docs_local:  # ADR 0014 4.2: no interactive docs outside local development
        from worker.signing import DOCS_PATHS

        app.router.routes = [
            r for r in app.router.routes if getattr(r, "path", "") not in DOCS_PATHS
        ]
    install_problem_handlers(app)
    app.include_router(router)
    app.add_middleware(SigningMiddleware, keys=keys or {}, docs_exempt=docs_local)
