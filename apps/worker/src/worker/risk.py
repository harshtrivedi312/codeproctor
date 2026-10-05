"""Risk score calculator (FR-804, FR-805, ADR 0005 section 2, TC-075, TC-076).

score = min(100, sum over types of min(count, cap) * points[severity] * weight[type])

Severity is assigned here from the event type (client-sent severity is never read, ADR 0001 TB-1).
Event types in `IntegrityConfig.disabled_event_types` (accommodations, FR-305) are dropped before
counting, so they never score. The result carries a per-type breakdown so a reviewer can see why.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

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


@dataclass(frozen=True, slots=True)
class ReviewRouting:
    """FR-805. The API applies the state change through SessionStateService."""

    needs_review: bool
    reasons: list[str]


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
    band: RiskBand, identity_review_pending: bool = False, short_answer_pending: bool = False
) -> ReviewRouting:
    """FR-805: MEDIUM or HIGH, a pending identity review, or a pending manual score -> review."""
    reasons: list[str] = []
    if band != "LOW":
        reasons.append(f"RISK_{band}")
    if identity_review_pending:
        reasons.append("IDENTITY_MANUAL_REVIEW")
    if short_answer_pending:
        reasons.append("SHORT_ANSWER_MANUAL_SCORING")
    return ReviewRouting(needs_review=bool(reasons), reasons=reasons)
