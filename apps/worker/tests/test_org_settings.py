"""Org settings guard (ADR 0014 6.1, hub rulings on bounds): FR-804, FR-802, FR-803, FR-607,
FR-305; owner decision C-28 / DL-18. Unknown, internal-only and out-of-bounds keys are a 422
problem+json: never clamped, never silently ignored."""

from __future__ import annotations

import json
from typing import Any

import pytest

from signed_app import make_app, send
from worker.config import IntegrityConfig
from worker.org_settings import (
    INTERNAL_ONLY_KEYS,
    ORG_BOUNDS,
    Bound,
    MapBound,
    OrgSettingsError,
    integrity_config_from_org_settings,
    validate_org_config,
)

RISK = {"events": [], "identityReviewPending": False, "shortAnswerPending": False}


def post_config(config: object) -> Any:
    return send(make_app(), "/v1/risk", {**RISK, "config": config})


def refused(config: object) -> dict[str, Any]:
    r = post_config(config)
    assert r.status_code == 422, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    assert "ok" not in r.json()
    return r.json()  # type: ignore[no-any-return]


# ---------- the table is sane ----------


def test_fr804_every_default_of_the_internal_config_lies_inside_the_org_bounds() -> None:
    cfg = json.loads(IntegrityConfig().model_dump_json(by_alias=True))
    for section, table in ORG_BOUNDS.items():
        for key, spec in table.items():
            if isinstance(spec, MapBound):
                continue
            value = cfg[section][key]
            assert isinstance(spec, Bound)
            if spec.kind != "bool":
                assert spec.lo is not None and spec.hi is not None
                assert spec.lo <= value <= spec.hi, f"{section}.{key} default {value}"


def test_fr804_internal_only_keys_are_not_org_settable() -> None:
    org_keys = {k for t in ORG_BOUNDS.values() for k in t}
    assert not (org_keys & INTERNAL_ONLY_KEYS)


# ---------- accepted ----------


def test_fr804_in_bounds_overrides_are_applied_exactly() -> None:
    cfg = validate_org_config(
        {
            "risk": {
                "capPerType": 5,
                "severityPoints": {"HIGH": 30},
                "weightByType": {"TAB_SWITCH": 0.5},
            },
            "keystrokes": {"burstMinChars": 120, "deletionRatioEnabled": True},
            "similarity": {"peerThreshold": 0.9},
            "vad": {"speechThreshold": 0.6},
            "disabledEventTypes": ["GAZE_AWAY"],
        }
    )
    assert cfg.risk.cap_per_type == 5 and cfg.risk.severity_points["HIGH"] == 30
    assert cfg.keystrokes.burst_min_chars == 120 and cfg.keystrokes.deletion_ratio_enabled
    assert cfg.similarity.peer_threshold == 0.9 and cfg.vad.speech_threshold == 0.6
    assert cfg.disabled_event_types == {"GAZE_AWAY"}


def test_fr804_an_empty_or_default_config_is_accepted_and_the_route_works() -> None:
    assert validate_org_config({}) == IntegrityConfig()
    assert post_config({}).status_code == 200


@pytest.mark.parametrize(
    ("section", "key"),
    [
        (s, k)
        for s, t in ORG_BOUNDS.items()
        for k, spec in t.items()
        if isinstance(spec, Bound) and spec.kind != "bool"
    ],
)
def test_fr804_each_bound_is_inclusive_and_one_step_outside_is_refused(
    section: str, key: str
) -> None:
    spec = ORG_BOUNDS[section][key]
    assert isinstance(spec, Bound) and spec.lo is not None and spec.hi is not None
    step = 1 if spec.kind == "int" else 0.001
    for edge in (spec.lo, spec.hi):
        if section == "risk" and key == "highMinScore" and edge == 200:
            continue  # the internal rule (high <= 100) refuses it: covered separately
        if section == "risk" and key == "mediumMinScore" and edge == 100:
            continue  # medium must stay below high
        try:
            validate_org_config({section: {key: edge}})
        except OrgSettingsError as e:  # only cross-field rules may refuse an edge value
            assert section == "risk" and key in {"highMinScore", "mediumMinScore"}, (key, e.fields)
    for outside in (spec.lo - step, spec.hi + step):
        with pytest.raises(OrgSettingsError) as err:
            validate_org_config({section: {key: outside}})
        assert err.value.code == "ORG_SETTINGS_INVALID" and err.value.fields == [f"{section}.{key}"]


def test_fr804_map_bounds_check_keys_and_values() -> None:
    bad_maps: list[dict[str, Any]] = [
        {"severityPoints": {"LOW": 101}},
        {"severityPoints": {"CRITICAL": 5}},
        {"capOverrides": {"TAB_SWITCH": 21}},
        {"capOverrides": {"NOT_AN_EVENT": 1}},
        {"weightByType": {"TAB_SWITCH": 5.1}},
        {"weightByType": {"TAB_SWITCH": -1}},
        {"weightByType": []},
    ]
    for bad in bad_maps:
        with pytest.raises(OrgSettingsError):
            validate_org_config({"risk": bad})
    ok = validate_org_config(
        {"risk": {"capOverrides": {"TAB_SWITCH": 0}, "weightByType": {"NO_FACE": 0}}}
    )
    assert ok.risk.cap_overrides == {"TAB_SWITCH": 0}


def test_fr804_high_must_exceed_medium_and_wrong_types_are_refused() -> None:
    with pytest.raises(OrgSettingsError):
        validate_org_config({"risk": {"mediumMinScore": 70, "highMinScore": 60}})
    for bad in (True, "5", None, 5.5, float("nan"), float("inf")):
        with pytest.raises(OrgSettingsError):
            validate_org_config({"risk": {"capPerType": bad}})
    with pytest.raises(OrgSettingsError):
        validate_org_config({"keystrokes": {"deletionRatioEnabled": 1}})
    with pytest.raises(OrgSettingsError):
        validate_org_config({"vad": {"speechThreshold": float("nan")}})
    with pytest.raises(OrgSettingsError):
        validate_org_config({"risk": "high"})
    with pytest.raises(OrgSettingsError):
        validate_org_config([])


# ---------- refused: legacy, internal-only, unknown ----------


def test_fr805_dl18_a_legacy_fast_review_bands_key_is_a_422_with_its_own_code() -> None:
    for key in ("fastReviewBands", "fast_review_bands"):
        body = refused({"risk": {key: ["LOW"]}})
        assert body["code"] == "ORG_SETTINGS_LEGACY_KEY"
        assert body["fields"] == ["risk.fastReviewBands"]


@pytest.mark.parametrize(
    ("section", "key"),
    [
        ("risk", "severityByType"),
        ("vad", "speakerMaxConfidence"),
        ("vad", "sampleRate"),
        ("vad", "frameSamples"),
        ("similarity", "commonFingerprintShare"),
        ("similarity", "commonMinCorpus"),
        ("similarity", "maxPeerMatches"),
        ("similarity", "maxMatchedRanges"),
        ("keystrokes", "runGapMs"),
        ("keystrokes", "excerptMaxChars"),
        ("vad", "speakerMinClusterMs"),
        ("vad", "speakerMinVoicedMs"),
        ("vad", "f0MinHz"),
        ("vad", "f0MaxHz"),
    ],
)
def test_fr804_internal_only_keys_are_a_422_naming_the_field(section: str, key: str) -> None:
    body = refused({section: {key: 1}})
    assert body["code"] == "ORG_SETTINGS_INVALID" and body["fields"] == [f"{section}.{key}"]


def test_adr0004_face_settings_are_never_accepted_from_a_request() -> None:
    for config in (
        {"face": {"matchThreshold": 0.1}},
        {"FACE_MATCH_THRESHOLD": "0.1"},
        {"vad": {"FACE_X": 1}},
    ):
        body = refused(config)
        assert body["code"] == "ORG_SETTINGS_INVALID"


def test_fr804_unknown_keys_are_refused_without_echoing_their_names() -> None:
    sentinel = "SENTINEL-secret-key-name"
    for config in ({sentinel: 1}, {"risk": {sentinel: 1}}, {"keystrokes": {sentinel: 1}}):
        r = post_config(config)
        assert r.status_code == 422 and sentinel not in r.text
        assert r.json()["fields"][0].endswith(".*") or r.json()["fields"] == ["config.*"]


def test_fr804_snake_case_keys_are_refused_the_org_shape_is_camel_case() -> None:
    refused({"risk": {"cap_per_type": 5}})


def test_fr804_nothing_is_clamped_an_out_of_bounds_value_never_reaches_the_analyzer() -> None:
    body = refused({"risk": {"capPerType": 10_000}})
    assert body["fields"] == ["risk.capPerType"]


def test_fr805_the_422_is_signed_like_any_other_response() -> None:
    r = post_config({"risk": {"fastReviewBands": ["LOW"]}})
    assert r.headers["x-cp-key-id"] == "k1" and r.headers["x-cp-signature"]


# ---------- the settings-shaped adapter ----------


def test_fr804_adapter_maps_organizations_settings_and_ignores_other_org_keys() -> None:
    settings = {
        "consentDeclineContact": "hr@example.test",
        "integrity": {"keystrokes": {"burstMinChars": 100}, "similarity": {"k": 6}},
        "risk": {"capPerType": 4},
    }
    cfg = integrity_config_from_org_settings(settings, ["NO_FACE"])
    assert cfg.keystrokes.burst_min_chars == 100 and cfg.similarity.k == 6
    assert cfg.risk.cap_per_type == 4 and cfg.disabled_event_types == {"NO_FACE"}
    assert integrity_config_from_org_settings({}) == IntegrityConfig()


def test_fr805_dl18_adapter_surfaces_the_legacy_key_instead_of_stripping_it() -> None:
    with pytest.raises(OrgSettingsError) as e:
        integrity_config_from_org_settings({"risk": {"fastReviewBands": ["LOW"]}})
    assert e.value.code == "ORG_SETTINGS_LEGACY_KEY"
    with pytest.raises(OrgSettingsError):
        integrity_config_from_org_settings({"integrity": {"face": {"matchThreshold": 0.5}}})


def test_fr804_org_error_never_carries_the_value() -> None:
    e = OrgSettingsError("ORG_SETTINGS_INVALID", ["a", "a", "b"])
    assert e.fields == ["a", "b"] and str(e) == "ORG_SETTINGS_INVALID"


def test_adr0004_a_face_key_is_refused_without_echoing_the_callers_key_name() -> None:
    sentinel = "FACE_SENTINEL_9f3a"
    for config in ({sentinel: 1}, {"risk": {sentinel: 1}}, {"vad": {sentinel: 1}}):
        r = post_config(config)
        assert r.status_code == 422 and sentinel not in r.text and "SENTINEL" not in r.text
        assert any(f.endswith(".FACE_*") for f in r.json()["fields"])


def test_fr804_huge_ints_are_a_422_not_an_overflow_500() -> None:
    for config in (
        {"risk": {"capPerType": 10**400}},
        {"keystrokes": {"burstMinChars": -(10**400)}},
        {"vad": {"minSpeechMs": 2**53 + 1}},
        {"risk": {"weightByType": {"TAB_SWITCH": 10**400}}},
    ):
        body = refused(config)
        assert body["code"] == "ORG_SETTINGS_INVALID"


def test_fr804_high_min_score_bound_matches_the_internal_rule() -> None:
    spec = ORG_BOUNDS["risk"]["highMinScore"]
    assert isinstance(spec, Bound) and spec.hi == 100
    refused({"risk": {"highMinScore": 100.5}})


def test_fr804_risk_and_disabled_types_inside_the_integrity_block_are_refused() -> None:
    for key in ("risk", "disabledEventTypes"):
        with pytest.raises(OrgSettingsError) as e:
            integrity_config_from_org_settings(
                {"integrity": {key: {"capPerType": 5} if key == "risk" else ["NO_FACE"]}}
            )
        assert e.value.code == "ORG_SETTINGS_INVALID" and e.value.fields == [f"integrity.{key}"]
    # The real places still work.
    cfg = integrity_config_from_org_settings({"risk": {"capPerType": 5}}, ["NO_FACE"])
    assert cfg.risk.cap_per_type == 5 and cfg.disabled_event_types == {"NO_FACE"}
