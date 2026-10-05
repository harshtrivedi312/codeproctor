"""QA tests written from docs/test-cases.md (TC-062, TC-073, TC-074, TC-075, TC-076) and fsd.md.

Names carry the TC ID as TC_nnn so the P1 gate (packages/qa/src/p1-gate.ts) can read the junit
report. They call the worker only through its public surface: the HTTP routes and the replay
function. Complements the module tests, which test the internals.
"""

from __future__ import annotations

import random

import pytest
from fastapi.testclient import TestClient

from helpers import batches, cursor, edit, human_intervals, typed
from worker.app import app
from worker.keystrokes import analyze_question
from worker.risk import route_for_review

client = TestClient(app)
AUTH = {"X-Internal-Token": "qa-token"}


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_INTERNAL_TOKEN", "qa-token")


def _analyze(events: list[dict[str, object]]) -> list[dict[str, object]]:
    bs = [b.model_dump(mode="json", by_alias=True) for b in batches(events)]
    r = client.post("/analyze/keystrokes", json={"batches": bs}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()[0]["findings"]  # type: ignore[no-any-return]


# ---------- TC-073 (FR-802): paste burst via typing tool ----------


def test_TC_073_xdotool_300_chars_in_half_a_second_raises_paste_burst_via_http() -> None:
    text = "".join(random.Random(1).choice("abcdefghij(){};= ") for _ in range(300))
    events = [edit(round(i * 0.5), text[i], offset=i) for i in range(300)]  # 300 chars in ~150 ms
    findings = _analyze(events)
    bursts = [f for f in findings if f["type"] == "PASTE_BURST"]
    assert len(bursts) == 1
    assert bursts[0]["payload"]["insertedChars"] == 300  # type: ignore[index]


def test_TC_073_same_300_chars_typed_by_a_human_over_a_minute_raise_no_burst() -> None:
    code = ("for i in range(10):\n    total += i * 2\n") * 9
    events, _ = typed(code[:300], 0, human_intervals(300, mean_ms=200))
    assert [f for f in _analyze(events) if f["type"] == "PASTE_BURST"] == []


def test_TC_073_cursor_noise_between_the_auto_typed_chars_does_not_hide_the_burst() -> None:
    events: list[dict[str, object]] = []
    for i in range(300):
        events.append(edit(i, "x", offset=i))
        events.append(cursor(i, offset=i + 1))
    events.sort(key=lambda e: int(e["t"]))  # type: ignore[call-overload]
    assert any(f["type"] == "PASTE_BURST" for f in _analyze(events))


def test_TC_073_burst_evidence_excerpt_is_bounded_and_confidence_is_a_probability() -> None:
    findings = _analyze([edit(0, "y" * 5000)])
    burst = next(f for f in findings if f["type"] == "PASTE_BURST")
    assert 0.0 <= float(burst["confidence"]) <= 1.0  # type: ignore[arg-type]
    assert len(str(burst["excerpt"])) <= 400


# ---------- TC-062 (FR-608): replay reproduces final code ----------


def test_TC_062_a_long_session_with_edits_deletions_and_shuffled_batches_replays_to_the_exact_code() -> (
    None
):
    rng = random.Random(7)
    doc = ""
    events: list[dict[str, object]] = []
    t = 0
    for _ in range(700):
        t += rng.randint(30, 400)
        if doc and rng.random() < 0.25:
            start = rng.randrange(len(doc))
            n = rng.randint(1, min(4, len(doc) - start))
            events.append(edit(t, "", offset=start, delete=n))
            doc = doc[:start] + doc[start + n :]
        else:
            at = rng.randint(0, len(doc))
            ch = rng.choice("abcdefghijklmnopqrstuvwxyz \n(){}")
            events.append(edit(t, ch, offset=at))
            doc = doc[:at] + ch + doc[at:]
    parts = batches(events)
    assert len(parts) >= 2
    shuffled = list(reversed(parts))  # arrival order is not trusted (NFR-08)
    assert analyze_question(shuffled).final_text == doc


# ---------- TC-074 (FR-803): identical submissions ----------

SOLUTION = (
    "def top_odds(values):\n    kept = []\n    for v in values:\n        if v % 2 == 1 and v > 10:\n"
    "            kept.append(v * 3 + 1)\n    return sorted(kept, reverse=True)[:5]\n"
)


def _similarity(codes: dict[str, str]) -> dict[str, list[dict[str, object]]]:
    subs = [
        {"session_id": s, "session_question_id": f"q-{s}", "language": "python", "code": c}
        for s, c in codes.items()
    ]
    r = client.post("/analyze/similarity", json={"submissions": subs}, headers=AUTH)
    assert r.status_code == 200
    return r.json()["findings_by_session"]  # type: ignore[no-any-return]


def test_TC_074_two_identical_submissions_each_get_a_code_similarity_finding_naming_the_other() -> (
    None
):
    out = _similarity({"cand-a": SOLUTION, "cand-b": SOLUTION})
    assert set(out) == {"cand-a", "cand-b"}
    for session, other in (("cand-a", "cand-b"), ("cand-b", "cand-a")):
        finding = out[session][0]
        assert finding["type"] == "CODE_SIMILARITY"
        assert other in str(finding)


def test_TC_074_renaming_every_variable_and_adding_comments_is_still_flagged() -> None:
    renamed = (
        SOLUTION.replace("values", "xs")
        .replace("kept", "res")
        .replace("v ", "n ")
        .replace("v)", "n)")
        .replace("top_odds", "pick")
        + "# my own notes\n"
    )
    assert set(_similarity({"a": SOLUTION, "b": renamed})) == {"a", "b"}


def test_TC_074_two_different_correct_solutions_are_not_flagged() -> None:
    other = (
        "def top_odds(values):\n    from heapq import nlargest\n"
        "    return nlargest(5, (3 * v + 1 for v in values if v > 10 and v & 1))\n"
    )
    assert _similarity({"a": SOLUTION, "b": other}) == {}


# ---------- TC-075 (FR-804) and TC-076 (FR-805) ----------


def _risk(types: list[str], config: dict[str, object] | None = None) -> dict[str, object]:
    body: dict[str, object] = {"events": [{"type": t} for t in types]}
    if config:
        body["config"] = config
    r = client.post("/risk", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


HIGH_TYPES = ["MULTIPLE_FACES", "PHONE_DETECTED"]
MEDIUM_TYPES = ["TAB_SWITCH", "NO_FACE", "GAZE_AWAY"]


def test_TC_075_two_high_and_three_medium_score_64_and_band_high_with_default_weights() -> None:
    out = _risk(HIGH_TYPES + MEDIUM_TYPES)
    assert out["score"] == 64.0 and out["band"] == "HIGH"


def test_TC_075_halving_the_high_weights_changes_the_score_and_band_as_configured() -> None:
    cfg: dict[str, object] = {
        "risk": {"weightByType": {"MULTIPLE_FACES": 0.5, "PHONE_DETECTED": 0.5}},
    }
    out = _risk(HIGH_TYPES + MEDIUM_TYPES, cfg)
    assert out["score"] == 44.0 and out["band"] == "MEDIUM"  # 20 x 0.5 x 2 + 3 x 8


@pytest.mark.parametrize(
    ("types", "band"),
    [
        ([], "LOW"),
        (["TAB_SWITCH", "TAB_SWITCH", "TAB_SWITCH"], "LOW"),  # 24
        (HIGH_TYPES + ["TAB_SWITCH"], "MEDIUM"),  # 48
        (HIGH_TYPES + ["TAB_SWITCH", "NO_FACE", "GAZE_AWAY"], "HIGH"),  # 64
    ],
)
def test_TC_075_band_follows_fr804_ranges(types: list[str], band: str) -> None:
    out = _risk(types)
    assert out["band"] == band


def test_TC_075_score_never_exceeds_100() -> None:
    out = _risk(HIGH_TYPES * 3 + ["SCREEN_SHARE_STOPPED"] * 5 + ["CODE_SIMILARITY"] * 5)
    assert out["score"] == 100.0 and out["band"] == "HIGH"


def test_TC_076_C28_every_band_goes_to_review_and_the_band_picks_the_path() -> None:
    assert route_for_review("HIGH").needs_review is True
    assert route_for_review("MEDIUM").needs_review is True
    low = route_for_review("LOW")
    assert low.needs_review is True and low.review_path == "fast"
    assert route_for_review("MEDIUM").review_path == "full"
    assert route_for_review("HIGH").review_path == "full"


def test_TC_076_C28_identity_and_short_answer_holds_force_the_full_path_with_reasons() -> None:
    r = route_for_review("LOW", identity_review_pending=True, short_answer_pending=True)
    assert r.needs_review is True and r.review_path == "full"
    assert r.reasons == ["RISK_LOW", "IDENTITY_MANUAL_REVIEW", "SHORT_ANSWER_MANUAL_SCORING"]


def test_TC_076_the_risk_route_band_for_a_medium_session_feeds_routing() -> None:
    out = _risk(["TAB_SWITCH"] * 3 + ["NO_FACE"] * 2)  # 24 + 16 = 40
    assert out["band"] == "MEDIUM"
    assert route_for_review("MEDIUM").reasons == ["RISK_MEDIUM"]
    assert out["needs_review"] is True and out["review_path"] == "full"
