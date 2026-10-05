"""Risk score calculator (FR-804, FR-805, ADR 0005 section 2, TC-075, TC-076; owner decision C-28).

C-28: a person reviews EVERY session; nothing is auto-cleared. The band no longer decides WHETHER a
session is reviewed. It orders the review queue (HIGH first, then MEDIUM, then LOW, higher score
first within a band) and picks the review path: "fast" (summary and one-click verdict) or "full".

score = min(100, sum over types of min(count, cap) * points[severity] * weight[type])

Severity is assigned here from the event type (client-sent severity is never read, ADR 0001 TB-1).
Event types in `IntegrityConfig.disabled_event_types` (accommodations, FR-305) are dropped before
counting, so they never score. The result carries a per-type breakdown so a reviewer can see why.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

from worker.config import IntegrityConfig
from worker.events import EventType, RiskBand, Severity, risk_band_for_score


class ScoredEvent(BaseModel):
    """Minimal event view for scoring. Unknown keys (such as a client `severity`) are ignored."""

    model_config = ConfigDict(extra="ignore", frozen=True)
    type: EventType


@dataclass(frozen=True, slots=True)
class TypeBreakdown:
    type: EventType
    severity: Severity
    count: int
    counted: int
    weight: float
    points: float


@dataclass(frozen=True, slots=True)
class RiskResult:
    score: float
    raw_score: float
    band: RiskBand
    breakdown: list[TypeBreakdown]
    ignored_disabled: int


ReviewPath = Literal["fast", "full"]

# Lower rank = reviewed earlier.
_BAND_RANK: Final[dict[RiskBand, int]] = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}


@dataclass(frozen=True, slots=True)
class ReviewRouting:
    """FR-805 as changed by C-28. The API applies the state change through SessionStateService.

    `needs_review` is always True. `review_path` is "fast" only for bands in
    `risk.fastReviewBands` (default LOW) and only when no identity review or manual short-answer
    score is pending; those holds force the "full" path. `queue_rank` is the band's queue priority
    (0 = first).
    """

    needs_review: bool
    reasons: list[str]
    review_path: ReviewPath
    queue_rank: int


@dataclass(frozen=True, slots=True)
class QueueItem:
    """What the review queue needs to order a session. `submitted_at_ms` breaks score ties (oldest
    first); `session_id` makes the order total and deterministic."""

    session_id: str
    band: RiskBand
    score: float
    submitted_at_ms: int


def calculate_risk(
    events: Iterable[ScoredEvent | EventType], config: IntegrityConfig | None = None
) -> RiskResult:
    cfg = config or IntegrityConfig()
    r = cfg.risk
    counts: Counter[EventType] = Counter()
    ignored = 0
    for e in events:
        t = e.type if isinstance(e, ScoredEvent) else e
        if not cfg.is_enabled(t):
            ignored += 1
            continue
        counts[t] += 1
    breakdown: list[TypeBreakdown] = []
    total = 0.0
    for t in sorted(counts):
        severity = r.severity_by_type[t]
        cap = r.cap_overrides.get(t, r.cap_per_type)
        counted = min(counts[t], cap)
        weight = r.weight_by_type[t]
        points = counted * r.severity_points[severity] * weight
        total += points
        breakdown.append(TypeBreakdown(t, severity, counts[t], counted, weight, points))
    score = round(min(100.0, total), 2)
    return RiskResult(
        score=score,
        raw_score=round(total, 2),
        band=risk_band_for_score(score, r.medium_min_score, r.high_min_score),
        breakdown=breakdown,
        ignored_disabled=ignored,
    )


def route_for_review(
    band: RiskBand,
    identity_review_pending: bool = False,
    short_answer_pending: bool = False,
    config: IntegrityConfig | None = None,
) -> ReviewRouting:
    """Every session is reviewed (C-28). Pick the review path and queue rank from the band."""
    cfg = config or IntegrityConfig()
    reasons = [f"RISK_{band}"]
    if identity_review_pending:
        reasons.append("IDENTITY_MANUAL_REVIEW")
    if short_answer_pending:
        reasons.append("SHORT_ANSWER_MANUAL_SCORING")
    held = identity_review_pending or short_answer_pending
    fast = band in cfg.risk.fast_review_bands and not held
    return ReviewRouting(
        needs_review=True,
        reasons=reasons,
        review_path="fast" if fast else "full",
        queue_rank=_BAND_RANK[band],
    )


def queue_sort_key(item: QueueItem) -> tuple[int, float, int, str]:
    """HIGH, MEDIUM, LOW; higher score first; older submission first; then session id."""
    return (_BAND_RANK[item.band], -item.score, item.submitted_at_ms, item.session_id)


def order_review_queue(items: Iterable[QueueItem]) -> list[QueueItem]:
    """Deterministic review order. Input order never changes the result."""
    return sorted(items, key=queue_sort_key)
