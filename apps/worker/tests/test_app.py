"""Transport rules of the worker app (ADR 0014 4.2, 6.1, 6.2, 6.4): every route but GET /health is
signed, body limits apply before analysis, errors are problem+json without echoing input, the
legacy token routes are gone. FR-802..FR-805, NFR-04; TC-073, TC-075."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from signed_app import KEY, make_app, send, sign_headers, verify_response
from worker import signing
from worker.app import UNSIGNED_PATHS, app, create_app
from worker.routes_analyze import ANALYSIS_CONCURRENCY, BODY_LIMITS

RISK_BODY = {"events": [], "identityReviewPending": False, "shortAnswerPending": False}
V1_POSTS = [
    "/v1/risk",
    "/v1/analyze/keystrokes",
    "/v1/analyze/similarity",
    "/v1/analyze/vad",
    "/v1/face/match",
    "/v1/face/recheck",
    "/v1/face/evict",
]


@pytest.fixture(autouse=True)
def _no_review_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RISK_FAST_REVIEW_BANDS", raising=False)


def test_nfr04_health_is_the_only_unsigned_route() -> None:
    a = make_app()
    r = send(a, "/health", signed=False, method="GET")
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    assert UNSIGNED_PATHS == frozenset({"/health"})


@pytest.mark.parametrize(
    "path",
    [
        *V1_POSTS,
        "/v1/ready",
        "/v1/nope",
        "/nope",
        "/",
        "/analyze/keystrokes",
        "/risk",
        "/docs",
        "/openapi.json",
    ],
)
@pytest.mark.parametrize("method", ["POST", "GET", "PUT", "DELETE"])
def test_nfr04_every_route_and_unknown_path_refuses_an_unsigned_request(
    path: str, method: str
) -> None:
    r = send(make_app(), path, {"x": 1}, method=method, signed=False)
    assert r.status_code == 401
    assert r.json()["code"] == "WORKER_AUTH_FAILED"
    assert "x-cp-signature" not in r.headers  # unsigned: the caller may not hold the key


@pytest.mark.parametrize("path", [*V1_POSTS, "/v1/nope", "/nope"])
def test_nfr04_a_wrong_key_or_tampered_body_is_refused_on_every_route(path: str) -> None:
    a = make_app()
    headers, _ = sign_headers(path, b"{}", key=b"z" * 32)
    assert send(a, path, raw=b"{}", signed=False, headers=headers).status_code == 401
    headers, _ = sign_headers(path, b"{}")
    assert send(a, path, raw=b'{"x":1}', signed=False, headers=headers).status_code == 401


def test_nfr04_the_old_internal_token_no_longer_opens_anything() -> None:
    a = make_app()
    for path in ("/risk", "/analyze/keystrokes", "/analyze/similarity", "/v1/risk"):
        r = send(a, path, RISK_BODY, signed=False, headers={"X-Internal-Token": "anything"})
        assert r.status_code == 401
    # Signed, the legacy paths simply do not exist (removed, ADR 0014 4.3).
    for path in ("/risk", "/analyze/keystrokes", "/analyze/similarity"):
        assert send(a, path, RISK_BODY).status_code == 404


def test_nfr04_the_signing_defaults_leave_a_gap_that_the_app_closes() -> None:
    """signing.py still exempts the legacy /risk and /analyze/ paths by default; app.py overrides it."""
    assert "/risk" in signing.UNSIGNED_PATHS and signing.UNSIGNED_PREFIXES == ("/analyze/",)
    a = make_app()
    mw = next(m for m in a.user_middleware if m.cls is signing.SigningMiddleware)  # type: ignore[comparison-overlap]
    assert mw.kwargs["unsigned_paths"] == UNSIGNED_PATHS and mw.kwargs["unsigned_prefixes"] == ()
    assert mw.kwargs["body_limits"] == BODY_LIMITS


def test_nfr04_docs_exist_only_in_local_development() -> None:
    assert send(make_app(), "/openapi.json", signed=False, method="GET").status_code == 401
    local = send(make_app(docs_local=True), "/openapi.json", signed=False, method="GET")
    assert local.status_code == 200 and "/v1/risk" in local.json()["paths"]


def test_nfr04_a_signed_request_is_accepted_and_the_response_is_signed() -> None:
    a = make_app()
    headers, nonce = sign_headers(
        "/v1/risk", b'{"events":[],"identityReviewPending":false,"shortAnswerPending":false}'
    )
    r = send(
        a,
        "/v1/risk",
        raw=b'{"events":[],"identityReviewPending":false,"shortAnswerPending":false}',
        signed=False,
        headers=headers,
    )
    assert r.status_code == 200
    assert verify_response(r, {"X-CP-Nonce": nonce})


def test_nfr04_no_key_configured_refuses_to_serve() -> None:
    r = send(make_app(keys={}), "/v1/risk", RISK_BODY)
    assert r.status_code == 503 and r.json()["code"] == "WORKER_NOT_CONFIGURED"


@pytest.mark.parametrize("path", sorted(BODY_LIMITS))
def test_nfr04_body_over_the_route_limit_is_413_before_any_analysis(
    path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("analysis must not run")

    import worker.routes_analyze as ra

    for name in ("analyze_question", "find_target_similarity", "analyze_audio", "calculate_risk"):
        monkeypatch.setattr(ra, name, boom)
    a = make_app()
    r = send(a, path, raw=b" " * (BODY_LIMITS[path] + 1))
    assert r.status_code == 413
    assert r.json()["code"] == "PAYLOAD_TOO_LARGE"
    assert r.headers["content-type"].startswith("application/problem+json")


def test_adr0014_6_2_body_limits_match_the_contract() -> None:
    mib = 1024 * 1024
    assert BODY_LIMITS == {
        "/v1/analyze/keystrokes": 16 * mib,
        "/v1/analyze/similarity": 16 * mib,
        "/v1/analyze/vad": 2 * mib,
        "/v1/risk": 8 * mib,
    }


def test_adr0014_6_1_a_400_is_problem_json_and_never_echoes_input() -> None:
    sentinel = "SENTINEL-candidate-code-9f3a"
    a = make_app()
    for path, payload in [
        ("/v1/risk", {**RISK_BODY, sentinel: 1}),
        ("/v1/risk", {**RISK_BODY, "events": [{"type": sentinel, "source": "CLIENT"}]}),
        ("/v1/analyze/similarity", {"target": {"code": sentinel}}),
        ("/v1/analyze/keystrokes", {"sessionQuestionId": sentinel, "batches": [{"x": sentinel}]}),
    ]:
        r = send(a, path, payload)
        assert r.status_code == 400
        assert r.headers["content-type"].startswith("application/problem+json")
        assert r.json()["code"] == "VALIDATION_FAILED"
        assert sentinel not in r.text


def test_adr0014_6_1_malformed_json_is_a_400_problem() -> None:
    r = send(make_app(), "/v1/risk", raw=b"{not json")
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"


def test_adr0014_6_6_a_third_concurrent_analysis_call_gets_worker_busy() -> None:
    a = make_app()
    sem = a.state.analysis_runtime.semaphore
    assert ANALYSIS_CONCURRENCY == 2
    assert sem.acquire(blocking=False) and sem.acquire(blocking=False)
    try:
        r = send(
            a,
            "/v1/analyze/similarity",
            {
                "target": {
                    "sessionId": "s1",
                    "sessionQuestionId": "q1",
                    "language": "python",
                    "code": "x = 1",
                }
            },
        )
    finally:
        sem.release()
        sem.release()
    assert r.status_code == 503 and r.json()["code"] == "WORKER_BUSY"
    assert r.headers["retry-after"] == "5"


def test_adr0014_6_2_every_200_carries_the_worker_version_and_lock_digest() -> None:
    r = send(make_app(), "/v1/risk", RISK_BODY)
    assert r.json()["workerVersion"] == "9.9.9"
    assert len(r.json()["lockDigest"]) == 12


def test_fr805_c28_dl18_bad_fast_review_bands_stops_the_worker_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import ValidationError

    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "MEDIUM")
    with pytest.raises(ValidationError), TestClient(create_app()):
        pass  # entering the client runs the lifespan startup
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "LOW")
    with TestClient(create_app()) as ok:
        assert ok.get("/health").json() == {"status": "ok"}


def test_nfr04_the_module_level_app_is_signed_too() -> None:
    """The app uvicorn serves: with no key configured it refuses (503) instead of running open."""
    r = TestClient(app).post("/v1/risk", json=RISK_BODY)
    assert r.status_code in {401, 503}
    assert KEY  # the helper key is not the module app's key


def test_nfr04_known_gap_the_health_exemption_is_by_path_not_by_method() -> None:
    """signing.py exempts the path `/health`, so `POST /health` is also unsigned (it answers 405)."""
    r = send(make_app(), "/health", {"x": 1}, method="POST", signed=False)
    assert r.status_code == 405  # reaches the router unsigned: harmless, but not "GET /health" only
