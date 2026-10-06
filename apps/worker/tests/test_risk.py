from __future__ import annotations

import random

import pytest
from pydantic import ValidationError

from worker.config import IntegrityConfig, ReviewPathConfig
from worker.events import EventType, RiskBand
from worker.risk import (
    QueueItem,
    ScoredEvent,
    calculate_risk,
    order_review_queue,
    queue_sort_key,
    route_for_review,
)


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


# ---------- C-28: every session is reviewed ----------


@pytest.mark.parametrize("band", ["LOW", "MEDIUM", "HIGH"])
@pytest.mark.parametrize("identity", [False, True])
@pytest.mark.parametrize("short", [False, True])
def test_fr805_c28_no_band_or_hold_combination_is_ever_auto_cleared(
    band: RiskBand, identity: bool, short: bool
) -> None:
    r = route_for_review(band, identity, short)
    assert r.needs_review is True
    assert r.review_path in {"fast", "full"} and f"RISK_{band}" in r.reasons


def test_fr805_c28_low_band_without_holds_takes_the_fast_path_others_the_full_path() -> None:
    assert route_for_review("LOW").review_path == "fast"
    assert route_for_review("MEDIUM").review_path == "full"
    assert route_for_review("HIGH").review_path == "full"


def test_fr805_c28_pending_identity_or_short_answer_forces_the_full_path() -> None:
    assert route_for_review("LOW", identity_review_pending=True).review_path == "full"
    assert route_for_review("LOW", short_answer_pending=True).review_path == "full"
    both = route_for_review("HIGH", True, True)
    assert both.reasons == ["RISK_HIGH", "IDENTITY_MANUAL_REVIEW", "SHORT_ANSWER_MANUAL_SCORING"]


def test_fr805_c28_dl18_fast_path_bands_come_from_system_env_low_only_or_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RISK_FAST_REVIEW_BANDS", raising=False)
    assert ReviewPathConfig.from_env({}).fast_review_bands == {"LOW"}
    assert route_for_review("LOW").review_path == "fast"  # default from the real environment
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "")  # set but empty: nothing is fast
    assert route_for_review("LOW").review_path == "full"
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", " LOW , ")
    assert route_for_review("LOW").review_path == "fast"
    for bad in ("MEDIUM", "LOW,MEDIUM", "HIGH", "URGENT", "low"):
        monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", bad)
        with pytest.raises(ValidationError):
            route_for_review("LOW")  # invalid env fails loudly, never falls back silently


def test_fr805_c28_dl18_route_accepts_an_explicit_system_config() -> None:
    off = ReviewPathConfig(fast_review_bands=frozenset())
    assert route_for_review("LOW", system=off).review_path == "full"
    with pytest.raises(ValidationError):
        ReviewPathConfig(fast_review_bands=frozenset({"MEDIUM"}))


def test_fr805_c28_dl18_fast_review_bands_are_not_an_org_setting() -> None:
    for key in ("fastReviewBands", "fast_review_bands"):
        with pytest.raises(ValidationError):
            cfg(**{key: ["LOW"]})  # RiskConfig forbids it
        with pytest.raises(ValidationError):
            IntegrityConfig.model_validate({key: ["LOW"]})
    assert "fast_review_bands" not in IntegrityConfig.model_fields


def test_fr804_non_finite_config_values_are_rejected() -> None:
    inf, nan = float("inf"), float("nan")
    for bad in (
        {"severityPoints": {"LOW": inf}},
        {"severityPoints": {"HIGH": nan}},
        {"weightByType": {"TAB_SWITCH": inf}},
        {"weightByType": {"TAB_SWITCH": nan}},
        {"mediumMinScore": nan},
        {"highMinScore": inf},
    ):
        with pytest.raises(ValidationError):
            cfg(**bad)


def test_fr805_c28_queue_rank_puts_high_first_then_medium_then_low() -> None:
    ranks = [route_for_review(b).queue_rank for b in ("HIGH", "MEDIUM", "LOW")]
    assert ranks == sorted(ranks) and len(set(ranks)) == 3


def test_fr805_c28_queue_order_is_band_then_score_then_age_then_id_and_deterministic() -> None:
    items = [
        QueueItem("e", "LOW", 10.0, 5),
        QueueItem("a", "HIGH", 61.0, 9),
        QueueItem("b", "HIGH", 90.0, 9),
        QueueItem("c", "MEDIUM", 40.0, 7),
        QueueItem("d", "MEDIUM", 40.0, 3),  # same score as c, older: first
        QueueItem("f", "MEDIUM", 40.0, 3),  # same score and age as d: by id
    ]
    expected = ["b", "a", "d", "f", "c", "e"]
    assert [i.session_id for i in order_review_queue(items)] == expected
    for seed in range(5):  # input order never changes the result
        shuffled = items[:]
        random.Random(seed).shuffle(shuffled)
        assert [i.session_id for i in order_review_queue(shuffled)] == expected
    assert queue_sort_key(items[1]) < queue_sort_key(items[3]) < queue_sort_key(items[0])


def test_fr804_fr305_c28_accommodated_detectors_stay_out_of_the_score_and_the_band() -> None:
    c = IntegrityConfig(disabled_event_types=frozenset({"GAZE_AWAY", "NO_FACE"}))
    gaze: EventType = "GAZE_AWAY"
    face: EventType = "NO_FACE"
    r = calculate_risk([gaze, gaze, gaze, face, face, face], c)
    assert r.score == 0.0 and r.band == "LOW" and r.ignored_disabled == 6
    routing = route_for_review(r.band)
    assert routing.needs_review is True and routing.review_path == "fast"  # still reviewed
