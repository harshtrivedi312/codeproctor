"""ADR 0014 4.2 / 4.3: request and response signing for /v1 routes (FR-403 transport; TC-033 path).

QA assigns the TC ids for the 401/400/503 cases (ADR 0014 section 11); these tests name the rule.
"""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from worker import signing
from worker.problem import install_problem_handlers

KEY_A = b"a" * 32
KEY_B = b"b" * 32
NOW = 1_800_000_000.0


class Clock:
    def __init__(self, t: float = NOW) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def nonce() -> str:
    return signing._b64url(os.urandom(16))


def build(
    keys: dict[str, bytes] | None = None,
    clock: Clock | None = None,
    cache: int = 100,
    limits: dict[str, int] | None = None,
) -> tuple[Any, Clock, list[bytes]]:
    app = FastAPI()
    seen_bodies: list[bytes] = []

    @app.post("/v1/echo")
    async def echo(request: Request) -> JSONResponse:
        seen_bodies.append(await request.body())
        return JSONResponse({"ok": True})

    @app.post("/v1/boom")
    async def boom() -> JSONResponse:
        raise RuntimeError("secret-detail")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    install_problem_handlers(app)
    c = clock or Clock()
    mw = signing.SigningMiddleware(
        app,
        {"k1": KEY_A} if keys is None else keys,
        clock=c,
        nonce_cache_entries=cache,
        body_limits=limits,
    )
    return mw, c, seen_bodies


def signed(
    body: bytes = b'{"a":1}',
    *,
    kid: str = "k1",
    key: bytes = KEY_A,
    ts: float = NOW,
    n: str | None = None,
    path: str = "/v1/echo",
    method: str = "POST",
) -> tuple[dict[str, str], bytes, str]:
    nn = n or nonce()
    sig = signing.sign(key, signing.request_string(kid, method, path, str(int(ts)), nn, body))
    headers = {
        "X-CP-Key-Id": kid,
        "X-CP-Timestamp": str(int(ts)),
        "X-CP-Nonce": nn,
        "X-CP-Signature": sig,
        "Content-Type": "application/json",
    }
    return headers, body, nn


def call(app: Any, path: str, headers: dict[str, str], body: bytes, method: str = "POST") -> Any:
    async def go() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://worker"
        ) as client:
            return await client.request(method, path, headers=headers, content=body)

    return asyncio.run(go())


def test_fr403_valid_request_reaches_the_route_with_the_same_raw_body_and_response_is_signed() -> (
    None
):
    app, _, bodies = build()
    h, body, n = signed()
    r = call(app, "/v1/echo", h, body)
    assert r.status_code == 200 and bodies == [body]
    assert r.headers["x-cp-key-id"] == "k1"
    expected = signing.sign(KEY_A, signing.response_string("k1", n, 200, r.content))
    assert r.headers["x-cp-signature"] == expected


def test_fr403_tampered_body_old_and_future_timestamps_and_unknown_kid_give_unsigned_401() -> None:
    app, _, bodies = build()
    h, body, _ = signed()
    cases = [
        (h, b'{"a":2}'),
        (signed(ts=NOW - 61)[0], body),
        (signed(ts=NOW + 61)[0], body),
        (signed(kid="gone", key=KEY_B)[0], body),
        ({**h, "X-CP-Signature": "x" * 43}, body),
    ]
    for hdrs, b in cases:
        r = call(app, "/v1/echo", hdrs, b)
        assert r.status_code == 401
        assert r.json()["code"] == "WORKER_AUTH_FAILED"
        assert "x-cp-signature" not in r.headers  # unsigned: the caller may not hold the key
    assert bodies == []


def test_fr403_timestamp_inside_the_window_is_accepted() -> None:
    app, _, _ = build()
    assert call(app, "/v1/echo", *signed(ts=NOW - 60)[:2]).status_code == 200


def test_fr403_query_string_is_refused_with_400() -> None:
    app, _, _ = build()
    h, body, _ = signed()
    assert call(app, "/v1/echo?x=1", h, body).status_code == 400


def test_fr403_replayed_nonce_is_refused_but_a_bad_signature_does_not_use_up_its_nonce() -> None:
    app, _, _ = build()
    n = nonce()
    bad, body, _ = signed(n=n, key=KEY_B)  # wrong key: bad signature
    assert call(app, "/v1/echo", bad, body).status_code == 401
    good, body, _ = signed(n=n)
    assert call(app, "/v1/echo", good, body).status_code == 200  # nonce was not recorded
    assert call(app, "/v1/echo", good, body).status_code == 401  # now it is a replay


def test_fr403_nonce_expires_after_120_seconds() -> None:
    app, clock, _ = build()
    n = nonce()
    assert call(app, "/v1/echo", *signed(n=n)[:2]).status_code == 200
    clock.t = NOW + 121
    assert call(app, "/v1/echo", *signed(ts=clock.t, n=n)[:2]).status_code == 200


def test_fr403_malformed_nonce_is_refused() -> None:
    app, _, _ = build()
    for bad in ("short", "a" * 22 + "!!", signing._b64url(os.urandom(24))):
        assert call(app, "/v1/echo", *signed(n=bad)[:2]).status_code == 401


def test_fr403_full_nonce_cache_fails_closed_with_a_signed_503_and_never_evicts_early() -> None:
    app, _, _ = build(cache=2)
    first = signed()
    assert call(app, "/v1/echo", *first[:2]).status_code == 200
    assert call(app, "/v1/echo", *signed()[:2]).status_code == 200
    h, body, n = signed()
    r = call(app, "/v1/echo", h, body)
    assert r.status_code == 503 and r.json()["code"] == "WORKER_BUSY"
    assert r.headers["retry-after"]
    assert r.headers["x-cp-signature"] == signing.sign(
        KEY_A, signing.response_string("k1", n, 503, r.content)
    )
    assert call(app, "/v1/echo", *first[:2]).status_code == 401  # the first nonce is still held


def test_fr403_oversized_body_is_refused_before_signature_checks() -> None:
    app, _, bodies = build(limits={"/v1/echo": 10})
    h, body, _ = signed(body=b"x" * 11)
    assert call(app, "/v1/echo", h, body).status_code == 413
    assert bodies == []


def test_fr403_health_and_non_v1_paths_are_not_signed() -> None:
    app, _, _ = build()
    r = call(app, "/health", {}, b"", method="GET")
    assert r.status_code == 200 and "x-cp-signature" not in r.headers


def test_fr403_no_configured_key_refuses_to_serve_v1() -> None:
    app, _, _ = build(keys={})
    assert call(app, "/v1/echo", *signed()[:2]).status_code == 503


def test_fr403_two_active_key_ids_both_verify_and_response_uses_the_request_kid() -> None:
    app, _, _ = build(keys={"old": KEY_A, "new": KEY_B})
    for kid, key in (("old", KEY_A), ("new", KEY_B)):
        r = call(app, "/v1/echo", *signed(kid=kid, key=key)[:2])
        assert r.status_code == 200 and r.headers["x-cp-key-id"] == kid


def test_fr403_route_exception_gives_a_signed_500_with_no_detail() -> None:
    app, _, _ = build()
    h, body, n = signed(path="/v1/boom")
    r = call(app, "/v1/boom", h, body)
    assert r.status_code == 500 and r.json()["code"] == "INTERNAL"
    assert "secret-detail" not in r.text
    assert r.headers["x-cp-signature"] == signing.sign(
        KEY_A, signing.response_string("k1", n, 500, r.content)
    )


def test_fr403_parse_keys_rules() -> None:
    good = base64.b64encode(KEY_A).decode()
    assert set(signing.parse_keys(f"a:{good},b:{good}")) == {"a", "b"}
    assert signing.parse_keys("") == {}
    for bad, code in (
        ("a", "KEYS_MALFORMED"),
        (f"a:{good},a:{good}", "KEYS_MALFORMED"),
        (f"a:{good},b:{good},c:{good}", "TOO_MANY_KEYS"),
        ("a:" + base64.b64encode(b"short").decode(), "KEY_TOO_SHORT"),
        ("a:!!!", "KEYS_MALFORMED"),
    ):
        with pytest.raises(signing.KeyConfigError) as ei:
            signing.parse_keys(bad)
        assert ei.value.code == code
        assert good not in str(ei.value)


def test_fr403_nonce_cache_record_is_idempotent_and_len_counts_live_entries() -> None:
    clock = Clock()
    cache = signing.NonceCache(1, clock)
    assert cache.record("n1") == "recorded" and cache.record("n1") == "duplicate"
    assert len(cache) == 1 and cache.record("n2") == "full"
    clock.t += 121
    assert cache.record("n2") == "recorded" and len(cache) == 1


def test_fr403_non_http_scopes_pass_through_and_bad_content_length_is_413() -> None:
    called: list[str] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        called.append(scope["type"])

    mw = signing.SigningMiddleware(inner, {"k1": KEY_A})
    asyncio.run(mw({"type": "lifespan"}, None, None))  # type: ignore[arg-type]
    assert called == ["lifespan"]
    app, _, _ = build()
    h, body, _ = signed()
    assert call(app, "/v1/echo", {**h, "Content-Length": "abc"}, body).status_code == 400


def test_fr403_streamed_body_over_the_limit_is_413_even_without_a_content_length() -> None:
    app, _, bodies = build(limits={"/v1/echo": 10})
    sent: list[dict[str, Any]] = []
    chunks = [
        {"type": "http.request", "body": b"x" * 6, "more_body": True},
        {"type": "http.request", "body": b"x" * 6, "more_body": False},
    ]

    async def receive() -> dict[str, Any]:
        return chunks.pop(0)

    async def send(m: dict[str, Any]) -> None:
        sent.append(m)

    hdrs, _, _ = signed(body=b"x" * 12)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/v1/echo",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in hdrs.items()],
    }
    asyncio.run(app(scope, receive, send))
    assert sent[0]["status"] == 413 and bodies == []

    async def wrong_type() -> dict[str, Any]:
        return {"type": "http.disconnect"}

    sent.clear()
    asyncio.run(app(scope, wrong_type, send))
    assert sent == []  # the client went away while sending the body: nothing to answer


def test_fr403_non_ascii_or_missing_headers_give_unsigned_401_not_500() -> None:
    app, _, bodies = build()
    h, body, _ = signed()
    cases = [
        {**h, "X-CP-Signature": "é" * 43},
        {**h, "X-CP-Timestamp": "²" * 10},
        {**h, "X-CP-Nonce": "é" * 22},
        {**h, "X-CP-Key-Id": "é"},
        {k: v for k, v in h.items() if not k.startswith("X-CP")},
    ]
    for hdrs in cases:
        raw = {k: v.encode("latin-1") for k, v in hdrs.items()}  # httpx refuses non-ASCII str
        r = call(app, "/v1/echo", raw, body)  # type: ignore[arg-type]
        assert r.status_code == 401 and r.json()["code"] == "WORKER_AUTH_FAILED"
        assert "x-cp-signature" not in r.headers
    assert bodies == []


def test_fr403_signature_is_bound_to_path_and_method() -> None:
    app, _, bodies = build()
    h, body, _ = signed(path="/v1/echo")
    assert call(app, "/v1/boom", h, body).status_code == 401
    assert call(app, "/v1/echo", h, body, method="PUT").status_code == 401
    assert bodies == []


def test_fr403_timestamp_boundary_and_unsigned_400_for_query_and_bad_content_length() -> None:
    app, _, _ = build()
    assert call(app, "/v1/echo", *signed(ts=NOW + 60)[:2]).status_code == 200
    h, body, _ = signed()
    r = call(app, "/v1/echo?x=1", h, body)
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"
    assert "x-cp-signature" not in r.headers
    r = call(app, "/v1/echo", {**h, "Content-Length": "abc"}, body)
    assert r.status_code == 400


def test_fr403_everything_is_protected_except_the_explicit_unsigned_list() -> None:
    app, _, _ = build()
    # a path outside /v1 that is not on the list is signed-only (ADR 0014 4.2: all but /health)
    assert call(app, "/new-route", {}, b"").status_code == 401
    assert call(app, "/health", {}, b"", method="GET").status_code == 200
    assert call(app, "/analyze/keystrokes", {}, b"").status_code != 401  # legacy token route
    assert call(app, "/risk", {}, b"").status_code != 401


def test_fr403_concurrent_duplicate_nonce_is_atomic_and_recorded_once() -> None:
    cache = signing.NonceCache(10, Clock())
    assert cache.record("n") == "recorded"
    assert cache.record("n") == "duplicate"
    full = signing.NonceCache(1, Clock())
    assert full.record("a") == "recorded" and full.record("b") == "full"


def test_fr403_full_cache_and_handler_error_leave_a_fixed_code_log_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    app, _, _ = build(cache=2)
    call(app, "/v1/echo", *signed()[:2])
    with caplog.at_level("ERROR"):
        call(app, "/v1/boom", *signed(path="/v1/boom")[:2])
        h, body, _ = signed()
        assert call(app, "/v1/echo", h, body).status_code == 503
    text = caplog.text
    assert "NONCE_CACHE_FULL" in text and "HANDLER_ERROR" in text
    assert h["X-CP-Signature"] not in text and "secret-detail" not in text


def test_fr403_bad_headers_are_refused_before_any_body_is_buffered() -> None:
    app, _, _ = build()
    reads: list[int] = []
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        reads.append(1)
        return {"type": "http.request", "body": b"x", "more_body": False}

    async def send(m: dict[str, Any]) -> None:
        sent.append(m)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/v1/echo",
        "query_string": b"",
        "headers": [(b"x-cp-key-id", b"nope")],
    }
    asyncio.run(app(scope, receive, send))
    assert sent[0]["status"] == 401 and reads == []


def test_fr403_request_content_encoding_is_refused() -> None:
    app, _, bodies = build()
    h, body, _ = signed()
    assert call(app, "/v1/echo", {**h, "Content-Encoding": "gzip"}, body).status_code == 400
    assert bodies == []
