from __future__ import annotations

import random
import time

import pytest
from fastapi.testclient import TestClient

from helpers import QID, T0, edit
from worker.app import app
from worker.events import MAX_SOURCE_CODE_LENGTH

client = TestClient(app)
AUTH = {"X-Internal-Token": "test-token"}


@pytest.fixture(autouse=True)
def _no_review_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RISK_FAST_REVIEW_BANDS", raising=False)


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_INTERNAL_TOKEN", "test-token")


def test_health_is_open() -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_nfr04_routes_refuse_without_token_or_with_wrong_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert client.post("/risk", json={"events": []}).status_code == 401
    assert (
        client.post("/risk", json={"events": []}, headers={"X-Internal-Token": "x"}).status_code
        == 401
    )
    monkeypatch.delenv("WORKER_INTERNAL_TOKEN")
    assert client.post("/risk", json={"events": []}, headers=AUTH).status_code == 503


def test_tc075_risk_route_returns_score_and_band() -> None:
    events = [
        {"type": t}
        for t in ["MULTIPLE_FACES", "PHONE_DETECTED", "TAB_SWITCH", "NO_FACE", "GAZE_AWAY"]
    ]
    body = client.post("/risk", json={"events": events}, headers=AUTH).json()
    assert body["score"] == 64.0 and body["band"] == "HIGH"


def test_tc073_keystroke_route_reports_paste_burst() -> None:
    batch = {
        "seq": 0,
        "sessionQuestionId": QID,
        "startedAt": T0,
        "events": [edit(10, "a" * 300)],
    }
    r = client.post("/analyze/keystrokes", json={"batches": [batch]}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()[0]["findings"][0]["type"] == "PASTE_BURST"


def test_tc074_similarity_route_flags_identical_code() -> None:
    code = "def f(a):\n    out = []\n    for x in a:\n        if x % 2 == 0 and x > 10:\n            out.append(x * 3 + 1)\n    return sorted(out, reverse=True)[:5]\n"
    subs = [
        {"session_id": s, "session_question_id": f"q{s}", "language": "python", "code": code}
        for s in ("a", "b")
    ]
    r = client.post("/analyze/similarity", json={"submissions": subs}, headers=AUTH)
    assert set(r.json()["findings_by_session"]) == {"a", "b"}


def test_nfr04_invalid_body_is_422() -> None:
    assert (
        client.post("/risk", json={"events": [{"type": "NOPE"}]}, headers=AUTH).status_code == 422
    )


def test_fr803_similarity_route_passes_starter_code_to_ai_check() -> None:
    scaffold = (
        "def f(a):\n    out = []\n    for x in a:\n        if x % 2 == 0 and x > 10:\n"
        "            out.append(x * 3 + 1)\n    return sorted(out, reverse=True)[:5]\n"
    )
    body: dict[str, object] = {
        "submissions": [
            {"session_id": "a", "session_question_id": "qa", "language": "python", "code": scaffold}
        ],
        "ai_references": [{"id": "r", "language": "python", "code": scaffold}],
    }
    control = client.post("/analyze/similarity", json=body, headers=AUTH).json()
    assert control["findings_by_session"]["a"][0]["type"] == "AI_LIKENESS"
    body["starter_code"] = {"python": scaffold}
    r = client.post("/analyze/similarity", json=body, headers=AUTH)
    assert r.json()["findings_by_session"] == {}


def _starter_body(n: int) -> dict[str, object]:
    return {
        "submissions": [
            {"session_id": "a", "session_question_id": "qa", "language": "python", "code": "x = 1"}
        ],
        "starter_code": {"python": "x" * n},
    }


def test_nfr04_oversized_starter_code_is_422_on_starter_code() -> None:
    r = client.post(
        "/analyze/similarity", json=_starter_body(MAX_SOURCE_CODE_LENGTH + 1), headers=AUTH
    )
    assert r.status_code == 422
    assert any("starter_code" in e["loc"] for e in r.json()["detail"])


def test_nfr04_starter_code_at_exact_limit_is_accepted() -> None:
    r = client.post("/analyze/similarity", json=_starter_body(MAX_SOURCE_CODE_LENGTH), headers=AUTH)
    assert r.status_code == 200


def _many_submission_body(n: int, refs: int) -> dict[str, object]:
    from test_similarity import MULTI_TODO
    from test_similarity_large_starter import _solution

    return {
        "submissions": [
            {
                "session_id": f"s{i}",
                "session_question_id": f"q{i}",
                "language": "python",
                "code": _solution(random.Random(i), 3, 2),
            }
            for i in range(n)
        ],
        "starter_code": {"python": MULTI_TODO},
        "ai_references": [
            {"id": f"r{i}", "language": "python", "code": _solution(random.Random(900 + i), 3, 2)}
            for i in range(refs)
        ],
    }


def test_nfr01_fr803_starter_and_references_are_prepared_once_per_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from worker import similarity

    n, refs = 20, 5
    calls = {"prepare": 0, "starter": 0}
    real_prepare, real_kgrams = similarity.prepare, similarity.all_kgram_hashes

    def counting_prepare(*a, **k):  # type: ignore[no-untyped-def]
        calls["prepare"] += 1
        return real_prepare(*a, **k)

    def counting_kgrams(*a, **k):  # type: ignore[no-untyped-def]
        calls["starter"] += 1
        return real_kgrams(*a, **k)

    monkeypatch.setattr(similarity, "prepare", counting_prepare)
    monkeypatch.setattr(similarity, "all_kgram_hashes", counting_kgrams)
    r = client.post("/analyze/similarity", json=_many_submission_body(n, refs), headers=AUTH)
    assert r.status_code == 200
    # Starter: once for the peer pass, once for the AI pass (one language), never per submission.
    assert calls["starter"] == 2
    # Each submission once for peers and once for AI, each reference exactly once.
    assert calls["prepare"] == 2 * n + refs


def test_nfr01_fr803_request_with_many_submissions_and_large_starter_is_fast_enough() -> None:
    body = _many_submission_body(120, 6)
    start = time.perf_counter()
    r = client.post("/analyze/similarity", json=body, headers=AUTH)
    elapsed = time.perf_counter() - start
    assert r.status_code == 200
    # Hang/runaway guard only. Measured about 1.2 s on a laptop but 10.9 s on a shared CI runner,
    # so the bound is deliberately loose; the call-count test above is what catches
    # per-submission re-preparation.
    assert elapsed < 60.0, f"{elapsed:.2f}s for 120 submissions"


def test_fr805_c28_risk_route_returns_review_path_queue_rank_and_always_needs_review() -> None:
    resp = client.post("/risk", json={"events": []}, headers=AUTH)
    assert resp.status_code == 200
    low = resp.json()
    assert low["band"] == "LOW" and low["needs_review"] is True
    assert low["review_path"] == "fast" and low["review_reasons"] == ["RISK_LOW"]
    held_resp = client.post(
        "/risk", json={"events": [], "identity_review_pending": True}, headers=AUTH
    )
    assert held_resp.status_code == 200
    held = held_resp.json()
    assert held["review_path"] == "full" and "IDENTITY_MANUAL_REVIEW" in held["review_reasons"]
    high_resp = client.post(
        "/risk",
        json={
            "events": [
                {"type": t}
                for t in ["MULTIPLE_FACES", "PHONE_DETECTED", "TAB_SWITCH", "NO_FACE", "GAZE_AWAY"]
            ]
        },
        headers=AUTH,
    )
    assert high_resp.status_code == 200
    high = high_resp.json()
    assert high["band"] == "HIGH" and high["review_path"] == "full"
    assert high["queue_rank"] < low["queue_rank"]


def test_fr805_c28_dl18_risk_request_config_cannot_set_fast_review_bands() -> None:
    body = {"events": [], "config": {"risk": {"fastReviewBands": ["LOW"]}}}
    assert client.post("/risk", json=body, headers=AUTH).status_code == 422
    body = {"events": [], "config": {"fastReviewBands": ["LOW"]}}
    assert client.post("/risk", json=body, headers=AUTH).status_code == 422


def test_fr805_c28_dl18_risk_route_reads_the_system_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "")
    r = client.post("/risk", json={"events": []}, headers=AUTH)
    assert r.status_code == 200 and r.json()["review_path"] == "full"
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "LOW")
    r = client.post("/risk", json={"events": []}, headers=AUTH)
    assert r.json()["review_path"] == "fast"


def test_fr805_c28_dl18_bad_fast_review_bands_stops_the_worker_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import ValidationError

    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "MEDIUM")
    with pytest.raises(ValidationError), TestClient(app):
        pass  # entering the client runs the lifespan startup
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "LOW")
    with TestClient(app) as ok:
        assert ok.get("/health").json() == {"status": "ok"}
