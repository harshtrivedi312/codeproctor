"""Org settings adapter for analysis requests (ADR 0014 6.1; FR-804, FR-305; owner decision C-28).

The API sends `config` already mapped from `organizations.settings.integrity` and `.risk`
(`IntegrityConfig` shape, camelCase). This module is the worker's guard on it. An org may set only
the keys in `ORG_BOUNDS`, each inside its bounds. Anything else is refused with a 422 problem+json,
never clamped and never silently ignored:
- a legacy `risk.fastReviewBands` key: code `ORG_SETTINGS_LEGACY_KEY`, so the API adapter can strip
  it (the fast-path bands are SYSTEM configuration, `RISK_FAST_REVIEW_BANDS`, DL-18);
- anything else unknown, internal-only (`INTERNAL_ONLY_KEYS`: `severityByType`, `sampleRate`,
  `FACE_*` and so on) or out of bounds: code `ORG_SETTINGS_INVALID` with the field paths. Names the
  caller chose are never echoed; an unknown key is shown as `*`.
Face settings are system configuration from the worker's environment and are never accepted here.

The bounds are PROPOSED values pending the owner (the hub puts them in packages/shared). They
live in the one table below, so changing one is a one-line edit. The internal `IntegrityConfig`
defaults and validation are separate and unchanged. The "floor against detection weakening"
(HIGH-severity types never excludable, similarity thresholds capped at 0.95, no keystroke limit
able to disable a detector) is an OWNER DECISION and is not implemented; it would be more
entries in this table.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal, get_args

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from worker.config import IntegrityConfig
from worker.events import EventType

LEGACY_RISK_KEYS: Final = frozenset({"fastReviewBands", "fast_review_bands"})
MAX_EXACT_INT: Final = 2**53
LEGACY_CODE: Final = "ORG_SETTINGS_LEGACY_KEY"
INVALID_CODE: Final = "ORG_SETTINGS_INVALID"


@dataclass(frozen=True, slots=True)
class Bound:
    kind: Literal["int", "float", "bool"]
    lo: float | None = None
    hi: float | None = None


@dataclass(frozen=True, slots=True)
class MapBound:
    """A dict-valued setting: allowed keys, and the bound each value must satisfy."""

    keys: frozenset[str]
    value: Bound


_SEVERITIES: Final = frozenset({"LOW", "MEDIUM", "HIGH"})
_EVENT_TYPES: Final = frozenset(get_args(EventType))

# --- THE BOUNDS TABLE (proposed; pending the owner) ---------------------------------------------
ORG_BOUNDS: Final[dict[str, dict[str, Bound | MapBound]]] = {
    "risk": {
        "severityPoints": MapBound(_SEVERITIES, Bound("float", 0, 100)),
        "capPerType": Bound("int", 1, 20),
        "capOverrides": MapBound(_EVENT_TYPES, Bound("int", 0, 20)),
        "weightByType": MapBound(_EVENT_TYPES, Bound("float", 0, 5)),
        "mediumMinScore": Bound("float", 1, 100),
        "highMinScore": Bound("float", 1, 100),
    },
    "keystrokes": {
        "burstMinChars": Bound("int", 20, 2000),
        "burstWindowMs": Bound("int", 100, 10_000),
        "undoMinChars": Bound("int", 5, 1000),
        "undoMemoryMs": Bound("int", 10_000, 600_000),
        "regularityMinSamples": Bound("int", 10, 500),
        "regularityMaxCv": Bound("float", 0.01, 0.5),
        "speedMaxMedianIntervalMs": Bound("int", 5, 200),
        "keyRepeatMinRun": Bound("int", 2, 50),
        "maxTypingFindingsPerQuestion": Bound("int", 1, 10),
        "idleMs": Bound("int", 30_000, 3_600_000),
        "completeMinChars": Bound("int", 50, 5000),
        "completeWindowMs": Bound("int", 5000, 300_000),
        "deletionRatioEnabled": Bound("bool"),
        "deletionRatioMinInserted": Bound("int", 100, 10_000),
        "deletionRatioMax": Bound("float", 0, 1),
    },
    "similarity": {
        "k": Bound("int", 3, 12),
        "window": Bound("int", 2, 10),
        "minTokens": Bound("int", 10, 500),
        "minFingerprints": Bound("int", 3, 100),
        "peerThreshold": Bound("float", 0.5, 1.0),
        "aiThreshold": Bound("float", 0.5, 1.0),
    },
    "vad": {
        "speechThreshold": Bound("float", 0.3, 0.9),
        "minSpeechMs": Bound("int", 100, 2000),
        "mergeGapMs": Bound("int", 100, 2000),
        "minEventMs": Bound("int", 500, 10_000),
        "speakerPitchRatio": Bound("float", 1.1, 3.0),
    },
}
# Settings that exist inside the worker but that an org can never set (named in error fields).
INTERNAL_ONLY_KEYS: Final = frozenset(
    {
        "severityByType", "fastReviewBands", "speakerMaxConfidence", "sampleRate", "frameSamples",
        "commonFingerprintShare", "commonMinCorpus", "maxPeerMatches", "maxMatchedRanges",
        "runGapMs", "excerptMaxChars", "speakerMinClusterMs", "speakerMinVoicedMs", "f0MinHz",
        "f0MaxHz", "face",
    }
)  # fmt: skip
TOP_LEVEL_KEYS: Final = frozenset({*ORG_BOUNDS, "disabledEventTypes"})


class OrgSettingsError(Exception):
    """A 422 for the caller: a fixed code and field paths, never the offending value."""

    def __init__(self, code: str, fields: Iterable[str] = ()) -> None:
        super().__init__(code)
        self.code = code
        self.fields = sorted(set(fields))[:20]


def _name(key: object, path: str) -> str:
    """The path of a refused key. Only names the worker itself defines are shown; others are `*`."""
    text = str(key)
    if text.upper().startswith("FACE_"):
        return f"{path}.FACE_*"  # the rest of the name is the caller's own text
    known = text in INTERNAL_ONLY_KEYS or text in LEGACY_RISK_KEYS
    return f"{path}.{text}" if known else f"{path}.*"


def _number_ok(value: object, bound: Bound) -> bool:
    if bound.kind == "bool":
        return isinstance(value, bool)
    if isinstance(value, bool):
        return False
    if not isinstance(value, int | float):
        return False
    if bound.kind == "int" and not isinstance(value, int):
        return False
    if isinstance(value, int) and abs(value) > MAX_EXACT_INT:
        return False  # a huge int would overflow the float comparisons below
    if not math.isfinite(value):
        return False
    return (bound.lo is None or value >= bound.lo) and (bound.hi is None or value <= bound.hi)


def _check_section(name: str, section: object, errors: list[str]) -> None:
    table = ORG_BOUNDS[name]
    if not isinstance(section, Mapping):
        errors.append(name)
        return
    for key, value in section.items():
        spec = table.get(str(key)) if isinstance(key, str) else None
        path = f"{name}.{key}"
        if spec is None:
            errors.append(_name(key, name))
        elif isinstance(spec, MapBound):
            if not isinstance(value, Mapping):
                errors.append(path)
                continue
            for k, v in value.items():
                if not isinstance(k, str) or k not in spec.keys or not _number_ok(v, spec.value):
                    errors.append(f"{path}.*")
        elif not _number_ok(value, spec):
            errors.append(path)


def validate_org_config(raw: object) -> IntegrityConfig:
    """The request `config` -> IntegrityConfig, or OrgSettingsError (422). No clamping."""
    if not isinstance(raw, Mapping):
        raise OrgSettingsError(INVALID_CODE, ["config"])
    risk = raw.get("risk")
    if isinstance(risk, Mapping) and any(k in LEGACY_RISK_KEYS for k in risk):
        raise OrgSettingsError(LEGACY_CODE, ["risk.fastReviewBands"])
    errors: list[str] = []
    for key in raw:
        if key not in TOP_LEVEL_KEYS:
            errors.append(_name(key, "config"))
    for name in ORG_BOUNDS:
        if name in raw:
            _check_section(name, raw[name], errors)
    if errors:
        raise OrgSettingsError(INVALID_CODE, errors)
    try:
        return IntegrityConfig.model_validate(dict(raw))
    except ValidationError as e:  # cross-field rules (for example high must exceed medium)
        fields = [str(err["loc"][0]) if err["loc"] else "config" for err in e.errors()]
        raise OrgSettingsError(INVALID_CODE, fields) from None


def integrity_config_from_org_settings(
    settings: Mapping[str, object],
    disabled_event_types: Iterable[str] = (),
) -> IntegrityConfig:
    """`organizations.settings` -> IntegrityConfig. Only `integrity` and `risk` are read.

    `integrity` holds `keystrokes`, `similarity` and `vad`; `risk` holds the RiskConfig overrides.
    `disabled_event_types` comes from the accommodations (FR-305), never from the org settings.
    The same refusals apply as for a request config, including the legacy `fastReviewBands` key.
    """
    raw: dict[str, Any] = {}
    integrity = settings.get("integrity")
    if isinstance(integrity, Mapping):
        # `integrity` carries analyzer thresholds only. A `risk` or `disabledEventTypes` inside it
        # would overwrite the real ones when merged, so it is refused (422), not merged.
        nested = [f"integrity.{k}" for k in ("risk", "disabledEventTypes") if k in integrity]
        if nested:
            raise OrgSettingsError(INVALID_CODE, nested)
        raw.update(integrity)
    risk = settings.get("risk")
    if isinstance(risk, Mapping):
        raw["risk"] = dict(risk)
    raw["disabledEventTypes"] = list(disabled_event_types)
    return validate_org_config(raw)


def install_org_settings_handler(app: FastAPI) -> None:
    async def on_org_settings(_request: Request, exc: Exception) -> Response:
        code = exc.code if isinstance(exc, OrgSettingsError) else INVALID_CODE
        fields = exc.fields if isinstance(exc, OrgSettingsError) else []
        body = {
            "type": "about:blank",
            "title": "Org settings refused",
            "status": 422,
            "code": code,
            "fields": fields,
        }
        return JSONResponse(body, status_code=422, media_type="application/problem+json")

    app.add_exception_handler(OrgSettingsError, on_org_settings)
