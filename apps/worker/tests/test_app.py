from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from helpers import QID, T0, edit
from worker.app import app

client = TestClient(app)
AUTH = {"X-Internal-Token": "test-token"}


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
