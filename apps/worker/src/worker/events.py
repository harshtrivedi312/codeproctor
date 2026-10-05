"""Python mirror of packages/shared/src/events.ts and keystroke.ts (ADR 0005, ADR 0010).

packages/shared is the source of truth; keep this file in step with it. Constants that must match
are listed in tests/test_contracts.py, which parses the TypeScript files so drift fails the build.
Everything a candidate browser sends is untrusted (ADR 0001 TB-1): keystroke models reject unknown
shapes, and severity is never read from input, only assigned from the event type.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EventType = Literal[
    "FULLSCREEN_EXIT",
    "TAB_SWITCH",
    "FOCUS_LOST",
    "PASTE_ATTEMPT",
    "COPY_ATTEMPT",
    "RIGHT_CLICK",
    "DEVTOOLS_OPEN",
    "SCREEN_SHARE_STOPPED",
    "MULTI_MONITOR",
    "VIRTUAL_CAMERA",
    "NO_FACE",
    "MULTIPLE_FACES",
    "FACE_MISMATCH",
    "GAZE_AWAY",
    "PHONE_DETECTED",
    "BOOK_DETECTED",
    "SPEECH_DETECTED",
    "MULTIPLE_VOICES",
    "DISCONNECTED",
    "RECONNECTED",
    "PASTE_BURST",
    "TYPING_ANOMALY",
    "CODE_SIMILARITY",
    "AI_LIKENESS",
    "PROCTOR_PAUSE",
    "PROCTOR_MESSAGE",
    "SIDE_CAMERA_DISCONNECTED",
    "SIDE_CAMERA_RECONNECTED",
    "DROP_ATTEMPT",
    "CUT_ATTEMPT",
    "SHORTCUT_BLOCKED",
    "EXTENSION_INTERFERENCE",
    "FULLSCREEN_RESTORED",
    "SCREEN_SHARE_RESUMED",
    "PROCTOR_RESUME",
    "IDLE_THEN_COMPLETE",
    "DETECTOR_UNAVAILABLE",
    "IDENTITY_MANUAL_REVIEW",
    "RESUME_OTP_FAILED",
]
Severity = Literal["LOW", "MEDIUM", "HIGH"]
RiskBand = Literal["LOW", "MEDIUM", "HIGH"]
CodeLanguage = Literal["python", "javascript", "java"]

DEFAULT_EVENT_SEVERITY: Final[dict[EventType, Severity]] = {
    "FULLSCREEN_EXIT": "MEDIUM",
    "TAB_SWITCH": "MEDIUM",
    "FOCUS_LOST": "MEDIUM",
    "PASTE_ATTEMPT": "LOW",
    "COPY_ATTEMPT": "LOW",
    "RIGHT_CLICK": "LOW",
    "DEVTOOLS_OPEN": "MEDIUM",
    "SCREEN_SHARE_STOPPED": "HIGH",
    "MULTI_MONITOR": "HIGH",
    "VIRTUAL_CAMERA": "HIGH",
    "NO_FACE": "MEDIUM",
    "MULTIPLE_FACES": "HIGH",
    "FACE_MISMATCH": "MEDIUM",
    "GAZE_AWAY": "MEDIUM",
    "PHONE_DETECTED": "HIGH",
    "BOOK_DETECTED": "MEDIUM",
    "SPEECH_DETECTED": "MEDIUM",
    "MULTIPLE_VOICES": "HIGH",
    "DISCONNECTED": "LOW",
    "RECONNECTED": "LOW",
    "PASTE_BURST": "HIGH",
    "TYPING_ANOMALY": "MEDIUM",
    "CODE_SIMILARITY": "HIGH",
    "AI_LIKENESS": "MEDIUM",
    "PROCTOR_PAUSE": "LOW",
    "PROCTOR_MESSAGE": "LOW",
    "SIDE_CAMERA_DISCONNECTED": "HIGH",
    "SIDE_CAMERA_RECONNECTED": "LOW",
    "DROP_ATTEMPT": "LOW",
    "CUT_ATTEMPT": "LOW",
    "SHORTCUT_BLOCKED": "LOW",
    "EXTENSION_INTERFERENCE": "MEDIUM",
    "FULLSCREEN_RESTORED": "LOW",
    "SCREEN_SHARE_RESUMED": "LOW",
    "PROCTOR_RESUME": "LOW",
    "IDLE_THEN_COMPLETE": "MEDIUM",
    "DETECTOR_UNAVAILABLE": "MEDIUM",
    "IDENTITY_MANUAL_REVIEW": "HIGH",
    "RESUME_OTP_FAILED": "MEDIUM",
}

ZERO_WEIGHT_EVENT_TYPES: Final[frozenset[EventType]] = frozenset(
    {
        "DISCONNECTED",
        "RECONNECTED",
        "PROCTOR_PAUSE",
        "PROCTOR_MESSAGE",
        "PROCTOR_RESUME",
        "SIDE_CAMERA_RECONNECTED",
        "FULLSCREEN_RESTORED",
        "SCREEN_SHARE_RESUMED",
        "IDENTITY_MANUAL_REVIEW",
        "RESUME_OTP_FAILED",
    }
)

DEFAULT_SEVERITY_POINTS: Final[dict[Severity, float]] = {"LOW": 2.0, "MEDIUM": 8.0, "HIGH": 20.0}
DEFAULT_EVENT_CAP_PER_TYPE: Final = 3
DEFAULT_MEDIUM_MIN_SCORE: Final = 30.0
DEFAULT_HIGH_MIN_SCORE: Final = 60.0

MAX_SOURCE_CODE_LENGTH: Final = 100_000
MAX_KEYSTROKE_OFFSET_MS: Final = 600_000
MAX_KEYSTROKE_EVENTS_PER_BATCH: Final = 1000
MAX_KEYSTROKE_BATCH_TEXT: Final = MAX_SOURCE_CODE_LENGTH  # EDIT text only
MAX_KEYSTROKE_BATCH_TOTAL_TEXT: Final = 2 * MAX_SOURCE_CODE_LENGTH  # RESET and EDIT text
MAX_BATCH_SEQ: Final = 2_147_483_647
MAX_EVENT_DURATION_MS: Final = 86_400_000


def risk_band_for_score(
    score: float,
    medium_min: float = DEFAULT_MEDIUM_MIN_SCORE,
    high_min: float = DEFAULT_HIGH_MIN_SCORE,
) -> RiskBand:
    """FR-804 band for a 0-100 score (0-29 LOW, 30-59 MEDIUM, 60-100 HIGH by default)."""
    s = min(100.0, max(0.0, score))
    if s >= high_min:
        return "HIGH"
    if s >= medium_min:
        return "MEDIUM"
    return "LOW"


# ---------- Keystroke contract (keystroke.ts) ----------

_OffsetMs = Annotated[int, Field(ge=0, le=MAX_KEYSTROKE_OFFSET_MS)]
_ModelOffset = Annotated[int, Field(ge=0, le=MAX_SOURCE_CODE_LENGTH)]
_Text = Annotated[str, Field(max_length=MAX_SOURCE_CODE_LENGTH)]


class KeystrokeReset(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["RESET"]
    t: _OffsetMs
    language: CodeLanguage
    text: _Text


class KeystrokeEdit(BaseModel):
    """Remove `delete_length` chars at `offset`, then insert `text` (UTF-16 offsets in the SDK)."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    kind: Literal["EDIT"]
    t: _OffsetMs
    offset: _ModelOffset
    delete_length: _ModelOffset = Field(alias="deleteLength")
    text: _Text

    @model_validator(mode="after")
    def _must_change_code(self) -> KeystrokeEdit:
        if self.delete_length == 0 and len(self.text) == 0:
            raise ValueError("An edit must change the code.")
        return self


class KeystrokeCursor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    kind: Literal["CURSOR"]
    t: _OffsetMs
    offset: _ModelOffset
    selection_length: _ModelOffset | None = Field(default=None, alias="selectionLength")


KeystrokeEvent = Annotated[
    KeystrokeReset | KeystrokeEdit | KeystrokeCursor, Field(discriminator="kind")
]


class KeystrokeBatch(BaseModel):
    """One signed keystroke batch for one question. Signature checks happen in the API."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    seq: Annotated[int, Field(ge=0, le=MAX_BATCH_SEQ)]
    session_question_id: str = Field(alias="sessionQuestionId", min_length=1)
    started_at: datetime = Field(alias="startedAt")
    events: Annotated[
        list[KeystrokeEvent], Field(min_length=1, max_length=MAX_KEYSTROKE_EVENTS_PER_BATCH)
    ]

    @model_validator(mode="after")
    def _time_ordered(self) -> KeystrokeBatch:
        previous = 0
        edit_text = 0
        all_text = 0
        for e in self.events:
            if e.t < previous:
                raise ValueError("Editor events must be in time order.")
            previous = e.t
            if isinstance(e, KeystrokeEdit):
                edit_text += len(e.text)
            if not isinstance(e, KeystrokeCursor):
                all_text += len(e.text)
        if edit_text > MAX_KEYSTROKE_BATCH_TEXT:
            raise ValueError("Too much inserted text in one batch.")
        if all_text > MAX_KEYSTROKE_BATCH_TOTAL_TEXT:
            raise ValueError("Too much text (resets and edits) in one batch.")
        return self


# ---------- Detector output ----------


class Finding(BaseModel):
    """Evidence for a human, never a verdict (role rule; FR-801).

    Maps onto a SERVER `proctor_events` row: `type`, `occurred_at_ms` (epoch milliseconds;
    keystroke findings use the untrusted client clock, batch `startedAt` + `t`, and the API clamps
    it to the session window; audio findings use the `audio_start_ms` the caller passes in),
    `duration_ms`, `confidence`, and the type-specific `payload` (validated against events.ts by
    the API) plus a short `excerpt`.
    The excerpt may contain candidate code and must never be logged.
    """

    model_config = ConfigDict(frozen=True)
    type: EventType
    occurred_at_ms: int = Field(ge=0)
    duration_ms: int = Field(ge=0, le=MAX_EVENT_DURATION_MS)
    confidence: float = Field(ge=0.0, le=1.0)
    payload: dict[str, str | int | float | bool | list[int]]
    excerpt: str | None = None
    # Extra numbers for the reviewer (for example interval statistics). Not part of the shared
    # payload schema, so the API stores them next to the event only if a contract allows it.
    details: dict[str, str | int | float | bool] = Field(default_factory=dict)
