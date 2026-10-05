"""Integrity configuration: every threshold and weight, with documented defaults (FR-804).

Defaults are documented in docs/integrity-config.md (apps/worker/INTEGRITY-CONFIG.md until the
architecture hub moves it). Organizations override any value through `organizations.settings.risk`
and `organizations.settings.integrity` (ADR 0005 section 2, ADR 0007 section 6); the shape of
OrgSettings in packages/shared is not final, so this module accepts snake_case or camelCase keys and
the API adapter in BE-12 must map into `IntegrityConfig.model_validate`.

Accommodations (FR-305): event types listed in `disabled_event_types` are never produced by the
analyzers and never scored by the risk calculator, whatever the events list contains.
"""

from __future__ import annotations

from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from worker.events import (
    DEFAULT_EVENT_CAP_PER_TYPE,
    DEFAULT_EVENT_SEVERITY,
    DEFAULT_HIGH_MIN_SCORE,
    DEFAULT_MEDIUM_MIN_SCORE,
    DEFAULT_SEVERITY_POINTS,
    ZERO_WEIGHT_EVENT_TYPES,
    EventType,
    Severity,
)

_Unit = Annotated[float, Field(ge=0.0, le=1.0)]
_Pos = Annotated[int, Field(gt=0)]


class _Base(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, alias_generator=to_camel, populate_by_name=True
    )


class KeystrokeConfig(_Base):
    """FR-802. Defaults in INTEGRITY-CONFIG.md section 1."""

    # Paste burst: more than `burst_min_chars` inserted within `burst_window_ms` (FR-802: 80 / 1 s).
    burst_min_chars: _Pos = 80
    burst_window_ms: _Pos = 1000
    # Re-insertion of text deleted in the last N ms is treated as undo/redo, not paste.
    undo_memory_ms: _Pos = 120_000
    undo_min_chars: _Pos = 20

    # Too-regular typing: coefficient of variation of single-character insert intervals.
    regularity_min_samples: _Pos = 40
    regularity_max_cv: Annotated[float, Field(gt=0.0)] = 0.12
    # Intervals longer than this end a typing run (thinking pauses are not typing rhythm).
    run_gap_ms: _Pos = 1500
    # Sustained speed outlier: median interval below this over a qualifying run (~25 chars/s).
    speed_max_median_interval_ms: _Pos = 40
    # Identical character repeated this many times in a row looks like key repeat, ignored.
    key_repeat_min_run: _Pos = 5
    max_typing_findings_per_question: _Pos = 3

    # Deletion ratio (deleted/inserted). Reported always, flagged only if enabled.
    deletion_ratio_enabled: bool = False
    deletion_ratio_min_inserted: _Pos = 500
    deletion_ratio_max: Annotated[float, Field(ge=0.0, le=1.0)] = 0.005

    # Idle then complete: no editor activity for idle_ms, then at least complete_min_chars inserted
    # within complete_window_ms of the first edit after the idle period.
    idle_ms: _Pos = 300_000
    complete_min_chars: _Pos = 200
    complete_window_ms: _Pos = 30_000

    excerpt_max_chars: _Pos = 200


class SimilarityConfig(_Base):
    """FR-803. Defaults in INTEGRITY-CONFIG.md section 2."""

    k: _Pos = 5  # k-gram size in normalized tokens
    window: _Pos = 4  # winnowing window in k-grams
    min_tokens: _Pos = 40  # below this the code is too short to compare
    peer_threshold: _Unit = 0.80
    ai_threshold: _Unit = 0.85
    # Fingerprints present in more than this share of the corpus are common idioms, ignored.
    common_fingerprint_share: _Unit = 0.5
    common_min_corpus: _Pos = 5
    max_peer_matches: _Pos = 3
    max_matched_ranges: _Pos = 10


class VadConfig(_Base):
    """FR-607 server re-check. Defaults in INTEGRITY-CONFIG.md section 3."""

    sample_rate: _Pos = 16_000
    frame_samples: _Pos = 512  # Silero VAD frame at 16 kHz (32 ms)
    speech_threshold: _Unit = 0.5
    min_speech_ms: _Pos = 250
    merge_gap_ms: _Pos = 500
    # SPEECH_DETECTED is emitted for merged segments at least this long.
    min_event_ms: _Pos = 2000
    # Speaker-change heuristic (pitch based, weak evidence, confidence capped).
    speaker_pitch_ratio: Annotated[float, Field(gt=1.0)] = 1.3
    speaker_min_cluster_ms: _Pos = 3000
    speaker_min_voiced_ms: _Pos = 1000
    speaker_max_confidence: _Unit = 0.6
    f0_min_hz: _Pos = 70
    f0_max_hz: _Pos = 400


class RiskConfig(_Base):
    """FR-804 / ADR 0005 section 2."""

    severity_points: dict[Severity, float] = Field(
        default_factory=lambda: dict(DEFAULT_SEVERITY_POINTS)
    )
    cap_per_type: _Pos = DEFAULT_EVENT_CAP_PER_TYPE
    cap_overrides: dict[EventType, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)
    severity_by_type: dict[EventType, Severity] = Field(
        default_factory=lambda: dict(DEFAULT_EVENT_SEVERITY)
    )
    weight_by_type: dict[EventType, Annotated[float, Field(ge=0.0)]] = Field(
        default_factory=lambda: {
            t: (0.0 if t in ZERO_WEIGHT_EVENT_TYPES else 1.0) for t in DEFAULT_EVENT_SEVERITY
        }
    )
    medium_min_score: float = DEFAULT_MEDIUM_MIN_SCORE
    high_min_score: float = DEFAULT_HIGH_MIN_SCORE

    @model_validator(mode="after")
    def _merge_defaults(self) -> Self:
        # Partial org overrides are layered over the defaults so a missing type never raises.
        merged_sev = {**DEFAULT_EVENT_SEVERITY, **self.severity_by_type}
        merged_w = {
            **{t: (0.0 if t in ZERO_WEIGHT_EVENT_TYPES else 1.0) for t in DEFAULT_EVENT_SEVERITY},
            **self.weight_by_type,
        }
        merged_pts = {**DEFAULT_SEVERITY_POINTS, **self.severity_points}
        object.__setattr__(self, "severity_by_type", merged_sev)
        object.__setattr__(self, "weight_by_type", merged_w)
        object.__setattr__(self, "severity_points", merged_pts)
        return self

    @model_validator(mode="after")
    def _bands(self) -> Self:
        if not 0 < self.medium_min_score < self.high_min_score <= 100:
            raise ValueError("Band edges must satisfy 0 < medium < high <= 100.")
        if any(p < 0 for p in self.severity_points.values()):
            raise ValueError("severity_points must not be negative.")
        return self


class IntegrityConfig(_Base):
    keystrokes: KeystrokeConfig = Field(default_factory=KeystrokeConfig)
    similarity: SimilarityConfig = Field(default_factory=SimilarityConfig)
    vad: VadConfig = Field(default_factory=VadConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    # Accommodations (FR-305): these types are never produced and never scored.
    disabled_event_types: frozenset[EventType] = frozenset()

    def is_enabled(self, event_type: EventType) -> bool:
        return event_type not in self.disabled_event_types
