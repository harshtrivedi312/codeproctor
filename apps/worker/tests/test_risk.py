from __future__ import annotations

import pytest
from pydantic import ValidationError

from worker.config import IntegrityConfig
from worker.events import EventType
from worker.risk import ScoredEvent, calculate_risk, route_for_review


def cfg(**risk: object) -> IntegrityConfig:
    return IntegrityConfig.model_validate({"risk": risk})


def test_tc075_two_high_and_three_medium_score_64_band_high() -> None:
    events: list[EventType] = [
        "MULTIPLE_FACES",
        "PHONE_DETECTED",
        "TAB_SWITCH",
        "NO_FACE",
        "GAZE_AWAY",
    ]
    r = calculate_risk(events)
    assert r.score == 64.0
    assert r.band == "HIGH"


def test_fr804_per_type_cap_stops_one_noisy_detector_reaching_100() -> None:
    r = calculate_risk(["NO_FACE"] * 50)
    assert r.score == 24.0 and r.band == "LOW"
    assert r.breakdown[0].count == 50 and r.breakdown[0].counted == 3


def test_fr804_score_is_capped_at_100() -> None:
    many: list[EventType] = [
        "MULTIPLE_FACES", "PHONE_DETECTED", "SCREEN_SHARE_STOPPED", "MULTI_MONITOR",
        "VIRTUAL_CAMERA", "PASTE_BURST", "CODE_SIMILARITY",
    ]  # fmt: skip
    r = calculate_risk([t for t in many for _ in range(3)])
    assert r.score == 100.0 and r.raw_score > 100


@pytest.mark.parametrize(
    ("events", "band"),
    [
        ([], "LOW"),
        (["TAB_SWITCH"] * 3 + ["RIGHT_CLICK"] * 2, "LOW"),  # 24 + 4 = 28
        (["TAB_SWITCH"] * 3 + ["RIGHT_CLICK"] * 3, "MEDIUM"),  # 30
        (["PHONE_DETECTED"] * 2 + ["TAB_SWITCH"] * 2 + ["RIGHT_CLICK"], "MEDIUM"),  # 58
    ],
)
def test_fr804_band_edges(events: list[EventType], band: str) -> None:
    r = calculate_risk(events)
    expected = {"LOW": r.score < 30, "MEDIUM": 30 <= r.score < 60, "HIGH": r.score >= 60}
    assert expected[band], (r.score, r.band)
    assert r.band == band


def test_fr804_band_boundaries_exactly_30_and_60() -> None:
    assert calculate_risk(["PHONE_DETECTED", "PHONE_DETECTED", "TAB_SWITCH"]).score == 48.0
    assert calculate_risk(["PHONE_DETECTED"] * 3).band == "HIGH"  # 60
    assert calculate_risk(["PHONE_DETECTED"] * 3).score == 60.0
    assert (
        calculate_risk(
            [
                "PHONE_DETECTED",
                "TAB_SWITCH",
                "RIGHT_CLICK",
                "RIGHT_CLICK",
                "RIGHT_CLICK",
                "RIGHT_CLICK",
            ]
        ).band
        == "MEDIUM"
    )  # 20+8+8=36


def test_fr804_informational_and_zero_weight_types_never_score() -> None:
    ignored: list[EventType] = [
        "DISCONNECTED", "RECONNECTED", "PROCTOR_PAUSE", "PROCTOR_MESSAGE", "PROCTOR_RESUME",
        "SIDE_CAMERA_RECONNECTED", "FULLSCREEN_RESTORED", "SCREEN_SHARE_RESUMED",
        "IDENTITY_MANUAL_REVIEW", "RESUME_OTP_FAILED",
    ]  # fmt: skip
    assert calculate_risk(ignored * 5).score == 0.0


def test_fr804_weights_points_caps_and_bands_are_configurable() -> None:
    c = cfg(
        weightByType={"TAB_SWITCH": 0.5},
        severityPoints={"MEDIUM": 10},
        capOverrides={"NO_FACE": 1},
        mediumMinScore=20,
        highMinScore=40,
    )
    assert calculate_risk(["TAB_SWITCH"] * 2, c).score == 10.0  # 2 * 10 * 0.5
    assert calculate_risk(["NO_FACE"] * 5, c).score == 10.0  # cap 1
    assert calculate_risk(["GAZE_AWAY"] * 2, c).band == "MEDIUM"  # 20
    heavy: list[EventType] = ["GAZE_AWAY", "GAZE_AWAY", "GAZE_AWAY", "BOOK_DETECTED"]
    assert calculate_risk(heavy, c).band == "HIGH"


def test_fr804_org_can_reclassify_severity_and_raise_a_zero_weight_type() -> None:
    c = cfg(severityByType={"GAZE_AWAY": "HIGH"}, weightByType={"RESUME_OTP_FAILED": 1})
    assert calculate_risk(["GAZE_AWAY"], c).score == 20.0
    assert calculate_risk(["RESUME_OTP_FAILED"], c).score == 8.0


def test_adr0005_client_sent_severity_is_ignored() -> None:
    ev = ScoredEvent.model_validate({"type": "RIGHT_CLICK", "severity": "HIGH"})
    assert calculate_risk([ev]).score == 2.0


def test_fr305_disabled_detectors_never_score() -> None:
    c = IntegrityConfig(disabled_event_types=frozenset({"GAZE_AWAY", "NO_FACE"}))
    r = calculate_risk(["GAZE_AWAY", "NO_FACE", "TAB_SWITCH"], c)
    assert r.score == 8.0 and r.ignored_disabled == 2
    assert {b.type for b in r.breakdown} == {"TAB_SWITCH"}


def test_fr804_invalid_config_is_rejected() -> None:
    for bad in (
        {"mediumMinScore": 70, "highMinScore": 60},
        {"mediumMinScore": 0},
        {"highMinScore": 101},
        {"severityPoints": {"LOW": -1}},
        {"weightByType": {"TAB_SWITCH": -1}},
        {"capPerType": 0},
    ):
        with pytest.raises(ValidationError):
            cfg(**bad)
    with pytest.raises(ValidationError):
        IntegrityConfig.model_validate({"risk": {"unknownKnob": 1}})


def test_fr804_snake_case_and_camel_case_config_keys_both_work() -> None:
    a = IntegrityConfig.model_validate({"risk": {"cap_per_type": 1}})
    b = IntegrityConfig.model_validate({"risk": {"capPerType": 1}})
    assert a == b and calculate_risk(["NO_FACE"] * 3, a).score == 8.0


def test_fr804_analytics_events_score_like_any_other_event() -> None:
    r = calculate_risk(["PASTE_BURST", "TYPING_ANOMALY", "AI_LIKENESS", "IDLE_THEN_COMPLETE"])
    assert r.score == 20 + 8 + 8 + 8


def test_tc076_medium_band_goes_to_review_queue() -> None:
    tab: EventType = "TAB_SWITCH"
    click: EventType = "RIGHT_CLICK"
    mixed = [tab, tab, tab, click, click, click]
    r = calculate_risk(mixed)
    assert r.band == "MEDIUM"
    assert route_for_review(r.band).needs_review is True


def test_fr805_low_band_completes_unless_a_human_task_is_pending() -> None:
    assert route_for_review("LOW").needs_review is False
    assert route_for_review("LOW", identity_review_pending=True).reasons == [
        "IDENTITY_MANUAL_REVIEW"
    ]
    both = route_for_review("HIGH", True, True)
    assert both.reasons == ["RISK_HIGH", "IDENTITY_MANUAL_REVIEW", "SHORT_ANSWER_MANUAL_SCORING"]
