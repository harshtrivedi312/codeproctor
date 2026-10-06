"""FastAPI surface for the analysis worker.

Thin by design: the job consumer and object storage hand-off arrive with Backend Steps 10 and 12.
Every route except /health needs the internal token (`WORKER_INTERNAL_TOKEN`); with no token
configured the routes refuse to run rather than run open. Request bodies hold candidate code, so
nothing here logs them.
"""

from __future__ import annotations

import hmac
import os
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from worker.config import IntegrityConfig
from worker.events import (
    MAX_SOURCE_CODE_LENGTH,
    CodeLanguage,
    Finding,
    KeystrokeBatch,
    RiskBand,
)
from worker.keystrokes import analyze_keystrokes
from worker.risk import ReviewPath, RiskResult, ScoredEvent, calculate_risk, route_for_review
from worker.similarity import (
    AiReference,
    Submission,
    find_ai_likeness,
    find_peer_similarity,
    prepare_ai_context,
)

app = FastAPI(title="CodeProctor analysis worker")


def require_internal_token(
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    expected = os.environ.get("WORKER_INTERNAL_TOKEN", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Worker token not configured.")
    if x_internal_token is None or not hmac.compare_digest(
        x_internal_token.encode(), expected.encode()
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized.")


Internal = Depends(require_internal_token)


class _Req(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    config: IntegrityConfig = Field(default_factory=IntegrityConfig)


class KeystrokeRequest(_Req):
    batches: list[KeystrokeBatch] = Field(min_length=1, max_length=5000)


class KeystrokeQuestionResult(BaseModel):
    session_question_id: str
    findings: list[Finding]
    final_text_length: int


class SubmissionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    session_question_id: str
    language: CodeLanguage
    code: str = Field(max_length=MAX_SOURCE_CODE_LENGTH)


class AiRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    language: CodeLanguage
    code: str = Field(max_length=MAX_SOURCE_CODE_LENGTH)
    is_variant_match: bool = False


class RiskResultOut(BaseModel):
    score: float
    raw_score: float
    band: RiskBand
    # C-28: every session is reviewed; the band picks the path and orders the queue.
    needs_review: bool
    review_path: ReviewPath
    queue_rank: int
    review_reasons: list[str]


class SimilarityRequest(_Req):
    submissions: list[SubmissionIn] = Field(min_length=1, max_length=2000)
    starter_code: dict[CodeLanguage, Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]] = (
        Field(default_factory=dict)
    )
    ai_references: list[AiRef] = Field(default_factory=list, max_length=100)


class SimilarityResult(BaseModel):
    findings_by_session: dict[str, list[Finding]]


class RiskRequest(_Req):
    events: list[ScoredEvent] = Field(max_length=100_000)
    identity_review_pending: bool = False
    short_answer_pending: bool = False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze/keystrokes", dependencies=[Internal])
def analyze_keystrokes_route(req: KeystrokeRequest) -> list[KeystrokeQuestionResult]:
    return [
        KeystrokeQuestionResult(
            session_question_id=a.session_question_id,
            findings=a.findings,
            final_text_length=len(a.final_text),
        )
        for a in analyze_keystrokes(req.batches, req.config)
    ]


@app.post("/analyze/similarity", dependencies=[Internal])
def analyze_similarity_route(req: SimilarityRequest) -> SimilarityResult:
    subs = [Submission(**s.model_dump()) for s in req.submissions]
    result = find_peer_similarity(subs, req.config, req.starter_code)
    refs = [AiReference(**r.model_dump()) for r in req.ai_references]
    if refs and req.config.is_enabled("AI_LIKENESS"):
        ctx = prepare_ai_context(refs, req.config, req.starter_code)  # once per request
        for s in subs:
            for f in find_ai_likeness(s, refs, req.config, context=ctx):
                result.setdefault(s.session_id, []).append(f)
    return SimilarityResult(findings_by_session=result)


@app.post("/risk", dependencies=[Internal])
def risk_route(req: RiskRequest) -> RiskResultOut:
    r: RiskResult = calculate_risk(req.events, req.config)
    routing = route_for_review(r.band, req.identity_review_pending, req.short_answer_pending)
    return RiskResultOut(
        score=r.score,
        band=r.band,
        raw_score=r.raw_score,
        needs_review=routing.needs_review,
        review_path=routing.review_path,
        queue_rank=routing.queue_rank,
        review_reasons=routing.reasons,
    )
