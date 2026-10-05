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

import os
from collections.abc import Mapping
from typing import Annotated, Final, Self

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
    RiskBand,
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
    # Distinct fingerprints left after ignoring starter code and idioms.
    min_fingerprints: _Pos = 12
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


class FaceConfig(_Base):
    """Face matching (FR-403, ADR 0004 section 2, D-05). Defaults in INTEGRITY-CONFIG.md section 7.

    SYSTEM CONFIGURATION, NOT AN ORG SETTING (ADR 0004 section 2, ADR 0007): this class is not part
    of `IntegrityConfig`, so `organizations.settings` cannot reach it. Load it with `from_env()`.

    PLACEHOLDER THRESHOLD: `match_threshold` is NOT tuned. It waits for the demographically diverse
    test set (INT-01, pilot entry criterion in ADR 0004 section 2). The default is deliberately high
    so that doubt goes to a human (MANUAL_REVIEW); it never rejects anyone.
    """

    # Cosine similarity at or above which the pair is a MATCH; below goes to MANUAL_REVIEW.
    match_threshold: Annotated[float, Field(ge=0.30, le=1.0)] = 0.75
    # Detector confidence (when the detector reports one) below this is treated as no usable face.
    min_detection_confidence: _Unit = 0.7
    # ID photo only: faces smaller than this share of the largest face's size are ignored (ghost
    # portrait, hologram). Selfies and re-check frames stay strictly single-face.
    id_secondary_face_ratio: Annotated[float, Field(gt=0.0, le=1.0)] = 0.5
    max_image_bytes: _Pos = 10 * 1024 * 1024
    # At most Pillow's guard value (set at import), so its 2x bomb check cannot override this limit.
    max_image_pixels: Annotated[int, Field(gt=0, le=25_000_000)] = 25_000_000
    # Selfie embeddings kept in memory for FR-606 re-checks (ADR 0004 section 2); bounded LRU.
    selfie_cache_max_sessions: _Pos = 256

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> FaceConfig:
        """Read system configuration from `FACE_*` environment variables; invalid values raise."""
        env = os.environ if environ is None else environ
        raw: dict[str, str] = {}
        for field, var in _FACE_ENV.items():
            if var in env:
                raw[field] = env[var]
        return cls.model_validate(raw)


_FACE_ENV: Final = {
    "match_threshold": "FACE_MATCH_THRESHOLD",
    "min_detection_confidence": "FACE_MIN_DETECTION_CONFIDENCE",
    "id_secondary_face_ratio": "FACE_ID_SECONDARY_FACE_RATIO",
    "max_image_bytes": "FACE_MAX_IMAGE_BYTES",
    "max_image_pixels": "FACE_MAX_IMAGE_PIXELS",
    "selfie_cache_max_sessions": "FACE_SELFIE_CACHE_MAX_SESSIONS",
}


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
    # C-28: every session gets a human review. The band picks the review path: bands listed here
    # get the fast path (summary and one-click verdict); the others get the full review. Only LOW
    # is allowed until the hub decides otherwise (empty set = everything full).
    fast_review_bands: frozenset[RiskBand] = frozenset({"LOW"})

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
        if not self.fast_review_bands <= {"LOW"}:
            raise ValueError(
                "Only the LOW band may use the fast review path (pending hub decision)."
            )
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
