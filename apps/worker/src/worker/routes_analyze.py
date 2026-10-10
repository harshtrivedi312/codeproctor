"""Signed analysis routes (ADR 0014 6.2: keystrokes, similarity, vad, risk; FR-802, FR-803,
FR-607, FR-804, FR-805; TC-061, TC-073, TC-074, TC-075, TC-076).

Each route is a pure function of its request: it calls the analyzer that already exists
(`analyze_question`, `find_target_similarity`, `analyze_audio`, `calculate_risk` and
`route_for_review`) and shapes the answer. JSON is camelCase, unknown request fields are refused,
and every 200 carries `workerVersion` and `lockDigest`. Requests are signed by the middleware
(signing.py); the body limit per route is in `BODY_LIMITS`. The `config` of a request goes through
the org settings guard (org_settings.py): out-of-bounds or internal-only keys are a 422, never
clamped. Analysis routes share a semaphore of 2 (ADR 0014 6.6): a third concurrent call gets 503
WORKER_BUSY at once. Bodies, code, keystroke text and audio are never logged; one fixed-code line
per call is.
"""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Final, Literal, Protocol

import numpy as np
import numpy.typing as npt
from fastapi import APIRouter, FastAPI, Request, Response
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from pydantic.alias_generators import to_camel

from worker.config import IntegrityConfig
from worker.events import (
    MAX_EVENT_DURATION_MS,
    MAX_SOURCE_CODE_LENGTH,
    CodeLanguage,
    EventType,
    Finding,
    KeystrokeBatch,
    RiskBand,
    risk_band_for_score,
)
from worker.keystrokes import analyze_question
from worker.org_settings import validate_org_config
from worker.problem import problem
from worker.risk import ReviewPath, calculate_risk, route_for_review
from worker.similarity import AiReference, Submission, find_target_similarity
from worker.vad import SileroOnnxBackend, VadBackend, analyze_audio

log = logging.getLogger(__name__)

ANALYSIS_CONCURRENCY: Final = 2
RETRY_AFTER_SECONDS: Final = "5"
_MIB: Final = 1024 * 1024
# ADR 0014 6.2, per route. The face routes keep the signing default (16 KiB).
BODY_LIMITS: Final[dict[str, int]] = {
    "/v1/analyze/keystrokes": 16 * _MIB,
    "/v1/analyze/similarity": 16 * _MIB,
    "/v1/analyze/vad": 2 * _MIB,
    "/v1/risk": 8 * _MIB,
}
_SESSION_ID: Final = r"^[A-Za-z0-9_-]{1,64}$"

OrgConfig = Annotated[IntegrityConfig, BeforeValidator(validate_org_config)]


class _Camel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=False, frozen=True
    )  # camelCase only (ADR 0014 6.1): a snake_case field name is an unknown field


class _Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    worker_version: str
    lock_digest: str


class FindingOut(BaseModel):
    """`Finding` as ADR 0014 6.2 names it (camelCase)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    type: EventType
    occurred_at_ms: int
    duration_ms: int
    confidence: float
    payload: dict[str, str | int | float | bool | list[int]]
    excerpt: str | None = None
    details: dict[str, str | int | float | bool | list[int]] | None = None

    @classmethod
    def of(cls, f: Finding) -> FindingOut:
        return cls(
            type=f.type,
            occurred_at_ms=f.occurred_at_ms,
            duration_ms=f.duration_ms,
            confidence=f.confidence,
            payload=f.payload,
            excerpt=f.excerpt,
            details=f.details or None,
        )


# ---------- requests and responses ----------


class KeystrokesRequest(_Camel):
    session_question_id: Annotated[str, Field(min_length=1, max_length=64)]
    batches: Annotated[list[KeystrokeBatch], Field(min_length=1, max_length=5000)]
    config: OrgConfig = Field(default_factory=IntegrityConfig)


class KeystrokesResponse(_Out):
    session_question_id: str
    findings: list[FindingOut]
    final_text_length: int


class TargetIn(_Camel):
    session_id: Annotated[str, Field(pattern=_SESSION_ID)]
    session_question_id: Annotated[str, Field(min_length=1, max_length=64)]
    language: CodeLanguage
    code: Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]


class CorpusIn(_Camel):
    session_id: Annotated[str, Field(pattern=_SESSION_ID)]
    language: CodeLanguage
    code: Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]


class AiReferenceIn(_Camel):
    id: Annotated[str, Field(min_length=1, max_length=64)]
    language: CodeLanguage
    code: Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]
    is_variant_match: bool = False


class SimilarityRequest(_Camel):
    target: TargetIn
    corpus: Annotated[list[CorpusIn], Field(max_length=500)] = Field(default_factory=list)
    ai_references: Annotated[list[AiReferenceIn], Field(max_length=100)] = Field(
        default_factory=list
    )
    starter_code: dict[CodeLanguage, Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]] = (
        Field(default_factory=dict)
    )
    config: OrgConfig = Field(default_factory=IntegrityConfig)


class SimilarityResponse(_Out):
    findings: list[FindingOut]


class AudioChunkIn(_Camel):
    seq: Annotated[int, Field(ge=0)]
    url: Annotated[str, Field(min_length=1, max_length=4096)]
    offset_ms: Annotated[int, Field(ge=0, le=MAX_EVENT_DURATION_MS)]


class AudioHeaderIn(_Camel):
    seq: Annotated[int, Field(ge=0)]
    url: Annotated[str, Field(min_length=1, max_length=4096)]


class VadRequest(_Camel):
    session_id: Annotated[str, Field(pattern=_SESSION_ID)]
    segment: Annotated[int, Field(ge=0)]
    window_start_ms: Annotated[int, Field(ge=0)]
    header: AudioHeaderIn
    chunks: Annotated[list[AudioChunkIn], Field(max_length=90)]
    config: OrgConfig = Field(default_factory=IntegrityConfig)


class VadResponse(_Out):
    findings: list[FindingOut]
    decoded_ms: int
    missing_seqs: list[int]


class RiskEventIn(_Camel):
    type: EventType
    source: Literal["CLIENT", "SERVER"]
    duration_ms: Annotated[int, Field(ge=0, le=MAX_EVENT_DURATION_MS)] | None = None


class RiskRequest(_Camel):
    events: Annotated[list[RiskEventIn], Field(max_length=100_000)]
    identity_review_pending: bool
    short_answer_pending: bool
    config: OrgConfig = Field(default_factory=IntegrityConfig)


class RiskResponse(_Out):
    score: Annotated[int, Field(ge=0, le=100)]
    band: RiskBand
    review_path: ReviewPath
    queue_rank: int
    reasons: list[str]


# ---------- audio (the decoder arrives in a later PR) ----------


class AudioUnavailable(Exception):
    """No audio decoder is configured here. Fixed code only."""


@dataclass(frozen=True, slots=True)
class AudioWindow:
    """Mono float32 samples at 16 kHz for one window, with what could not be read."""

    samples: npt.NDArray[np.float32]
    decoded_ms: int
    missing_seqs: tuple[int, ...] = ()


class AudioProvider(Protocol):
    def load(self, request: VadRequest) -> AudioWindow: ...


class UnconfiguredAudio:
    """Default provider: fetching and decoding WebM/Opus (FFmpeg) is a later PR."""

    def load(self, request: VadRequest) -> AudioWindow:
        raise AudioUnavailable


def default_vad_backend() -> VadBackend:  # pragma: no cover - needs onnxruntime and the model
    import os
    from pathlib import Path

    models = os.environ.get("WORKER_MODELS_DIR", "")
    if not models:
        raise AudioUnavailable
    return SileroOnnxBackend(Path(models) / "silero-vad" / "silero_vad.onnx")


@dataclass
class AnalysisRuntime:
    """What the routes need beyond the request, held on `app.state` (never in a module global)."""

    audio: AudioProvider
    vad_backend: Callable[[], VadBackend]
    semaphore: threading.BoundedSemaphore


router = APIRouter(prefix="/v1")


def _rt(request: Request) -> AnalysisRuntime:
    rt: AnalysisRuntime = request.app.state.analysis_runtime
    return rt


def _versions(request: Request) -> dict[str, str]:
    face = request.app.state.face_runtime
    return {"worker_version": face.worker_version, "lock_digest": face.lock_digest}


def _busy() -> Response:
    return problem(503, "WORKER_BUSY", "Worker busy", {"Retry-After": RETRY_AFTER_SECONDS})


def _bad_request() -> Response:
    return problem(400, "VALIDATION_FAILED", "Request refused")


_CAMEL: Final[dict[str, Any]] = {
    "response_model_by_alias": True,
    "response_model_exclude_none": True,
}


@router.post("/analyze/keystrokes", response_model=KeystrokesResponse, **_CAMEL)
def keystrokes(body: KeystrokesRequest, request: Request) -> KeystrokesResponse | Response:
    """FR-802, TC-073. One call per session question; every batch must be for that question."""
    rt = _rt(request)
    if any(b.session_question_id != body.session_question_id for b in body.batches):
        return _bad_request()
    if not rt.semaphore.acquire(blocking=False):
        log.warning("analyze route=keystrokes outcome=WORKER_BUSY")
        return _busy()
    try:
        result = analyze_question(body.batches, body.config)
        log.info("analyze route=keystrokes outcome=OK findings=%d", len(result.findings))
        return KeystrokesResponse(
            session_question_id=result.session_question_id,
            findings=[FindingOut.of(f) for f in result.findings],
            final_text_length=len(result.final_text),
            **_versions(request),
        )
    finally:
        rt.semaphore.release()


@router.post("/analyze/similarity", response_model=SimilarityResponse, **_CAMEL)
def similarity(body: SimilarityRequest, request: Request) -> SimilarityResponse | Response:
    """FR-803, TC-074. Findings for the target only (peer and AI likeness)."""
    rt = _rt(request)
    if not rt.semaphore.acquire(blocking=False):
        log.warning("analyze route=similarity outcome=WORKER_BUSY")
        return _busy()
    try:
        t = body.target
        target = Submission(t.session_id, t.session_question_id, t.language, t.code)
        corpus = [Submission(c.session_id, "", c.language, c.code) for c in body.corpus]
        refs = [
            AiReference(r.id, r.language, r.code, r.is_variant_match) for r in body.ai_references
        ]
        findings = find_target_similarity(target, corpus, body.config, body.starter_code, refs)
        log.info("analyze route=similarity outcome=OK findings=%d", len(findings))
        return SimilarityResponse(
            findings=[FindingOut.of(f) for f in findings], **_versions(request)
        )
    finally:
        rt.semaphore.release()


@router.post("/analyze/vad", response_model=VadResponse, **_CAMEL)
def vad(body: VadRequest, request: Request) -> VadResponse | Response:
    """FR-607, TC-061. Speech and second-voice evidence for one audio window."""
    rt = _rt(request)
    cfg = body.config
    if not (cfg.is_enabled("SPEECH_DETECTED") or cfg.is_enabled("MULTIPLE_VOICES")):
        # Accommodation (FR-305): no audio is fetched and no model runs.
        return VadResponse(findings=[], decoded_ms=0, missing_seqs=[], **_versions(request))
    if not rt.semaphore.acquire(blocking=False):
        log.warning("analyze route=vad outcome=WORKER_BUSY")
        return _busy()
    try:
        try:
            window = rt.audio.load(body)
            backend = rt.vad_backend()
        except AudioUnavailable:
            log.warning("analyze route=vad outcome=WORKER_NOT_CONFIGURED")
            return problem(503, "WORKER_NOT_CONFIGURED", "Audio decoding not configured")
        findings = analyze_audio(window.samples, backend, cfg, audio_start_ms=body.window_start_ms)
        log.info("analyze route=vad outcome=OK findings=%d", len(findings))
        return VadResponse(
            findings=[FindingOut.of(f) for f in findings],
            decoded_ms=window.decoded_ms,
            missing_seqs=list(window.missing_seqs),
            **_versions(request),
        )
    finally:
        rt.semaphore.release()


@router.post("/risk", response_model=RiskResponse, **_CAMEL)
def risk(body: RiskRequest, request: Request) -> RiskResponse:
    """FR-804, FR-805, TC-075, TC-076. Cheap, so it is not behind the analysis semaphore."""
    result = calculate_risk([e.type for e in body.events], body.config)
    # Floor, not round: 29.6 is band LOW, so it must not read as 30. The band comes from the
    # INTEGER score the API stores, so score and band never disagree (ADR 0014 5.2).
    score = min(100, max(0, math.floor(result.score)))
    band = risk_band_for_score(
        score, body.config.risk.medium_min_score, body.config.risk.high_min_score
    )
    routing = route_for_review(band, body.identity_review_pending, body.short_answer_pending)
    log.info("analyze route=risk outcome=OK band=%s", band)
    return RiskResponse(
        score=score,
        band=band,
        review_path=routing.review_path,
        queue_rank=routing.queue_rank,
        reasons=routing.reasons,
        **_versions(request),
    )


def install_analyze_routes(
    app: FastAPI,
    *,
    audio: AudioProvider | None = None,
    vad_backend: Callable[[], VadBackend] | None = None,
) -> None:
    """Add the /v1 analysis routes. Needs `app.state.face_runtime` (worker version, lock digest)."""
    app.state.analysis_runtime = AnalysisRuntime(
        audio=audio or UnconfiguredAudio(),
        vad_backend=vad_backend or default_vad_backend,
        semaphore=threading.BoundedSemaphore(ANALYSIS_CONCURRENCY),
    )
    app.include_router(router)
