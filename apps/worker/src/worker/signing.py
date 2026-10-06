"""HMAC request and response signing for /v1 routes (ADR 0014 4.2, 4.3).

Pure ASGI middleware. Checks, in the ADR's order: (0) no query string, (1) body size, (2) known key
id, (3) timestamp within 60 s, (4) nonce not seen, (5) signature over the RAW body, (6) only then
record the nonce, (7) parse. Failures in 2 to 5 are an unsigned 401 WORKER_AUTH_FAILED with no
detail. Every response sent after step 5 is signed with the same key id. Nothing here logs.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from typing import Any, Final

from worker.problem import problem_body

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

REQ_PREFIX: Final = "CP-WORKER-V1"
RESP_PREFIX: Final = "CP-WORKER-V1-RESP"
WINDOW_SECONDS: Final = 60
NONCE_TTL_SECONDS: Final = 120
MIN_KEY_BYTES: Final = 32
MAX_KEYS: Final = 2
DEFAULT_NONCE_CACHE_ENTRIES: Final = 20_000
DEFAULT_BODY_LIMIT: Final = 16 * 1024
_KID: Final = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_B64URL: Final = re.compile(r"^[A-Za-z0-9_-]+$")


class KeyConfigError(Exception):
    """WORKER_HMAC_KEYS is malformed or holds a short key. Fixed code only (no key material)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_keys(spec: str) -> dict[str, bytes]:
    """`kid:base64,kid:base64` (at most 2; each key at least 32 bytes). Empty spec gives {}."""
    keys: dict[str, bytes] = {}
    if not spec.strip():
        return keys
    for part in spec.split(","):
        kid, sep, b64 = part.strip().partition(":")
        if not sep or not _KID.match(kid) or kid in keys:
            raise KeyConfigError("KEYS_MALFORMED")
        try:
            key = base64.b64decode(b64 + "=" * (-len(b64) % 4), validate=True)
        except (binascii.Error, ValueError):
            raise KeyConfigError("KEYS_MALFORMED") from None
        if len(key) < MIN_KEY_BYTES:
            raise KeyConfigError("KEY_TOO_SHORT")
        keys[kid] = key
    if len(keys) > MAX_KEYS:
        raise KeyConfigError("TOO_MANY_KEYS")
    return keys


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def request_string(kid: str, method: str, path: str, ts: str, nonce: str, body: bytes) -> bytes:
    return "\n".join(
        [REQ_PREFIX, kid, method, path, ts, nonce, hashlib.sha256(body).hexdigest()]
    ).encode()


def response_string(kid: str, nonce: str, status: int, body: bytes) -> bytes:
    return "\n".join(
        [RESP_PREFIX, kid, nonce, str(status), hashlib.sha256(body).hexdigest()]
    ).encode()


def sign(key: bytes, message: bytes) -> str:
    return _b64url(hmac.new(key, message, hashlib.sha256).digest())


class NonceCache:
    """Seen nonces for 120 s. Never evicted early: when full, new requests are refused."""

    def __init__(self, max_entries: int, clock: Callable[[], float] = time.time) -> None:
        self._max = max_entries
        self._clock = clock
        self._items: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def _sweep(self, now: float) -> None:
        while self._items:
            nonce, expires = next(iter(self._items.items()))
            if expires > now:
                break
            del self._items[nonce]

    def seen(self, nonce: str) -> bool:
        with self._lock:
            self._sweep(self._clock())
            return nonce in self._items

    def record(self, nonce: str) -> bool:
        """False when the cache is full (the caller answers 503 WORKER_BUSY)."""
        with self._lock:
            now = self._clock()
            self._sweep(now)
            if nonce in self._items:
                return True
            if len(self._items) >= self._max:
                return False
            self._items[nonce] = now + NONCE_TTL_SECONDS
            return True

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


class SigningMiddleware:
    """Signs and verifies `/v1/` traffic. `/health` and non-/v1 paths pass through unchanged."""

    def __init__(
        self,
        app: ASGIApp,
        keys: Mapping[str, bytes],
        *,
        body_limits: Mapping[str, int] | None = None,
        nonce_cache_entries: int = DEFAULT_NONCE_CACHE_ENTRIES,
        clock: Callable[[], float] = time.time,
        protected_prefix: str = "/v1/",
    ) -> None:
        self.app = app
        self._keys = dict(keys)
        self._limits = dict(body_limits or {})
        self._clock = clock
        self._nonces = NonceCache(nonce_cache_entries, clock)
        self._prefix = protected_prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(self._prefix):
            await self.app(scope, receive, send)
            return
        if not self._keys:  # no key: refuse to serve rather than run open (ADR 0014 4.3)
            await self._plain(send, 503, "WORKER_NOT_CONFIGURED", "Worker not configured")
            return
        if scope.get("query_string"):
            await self._plain(send, 400, "VALIDATION_FAILED", "Query strings are not accepted")
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        limit = self._limits.get(scope["path"], DEFAULT_BODY_LIMIT)
        declared = headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            await self._plain(send, 413, "PAYLOAD_TOO_LARGE", "Payload too large")
            return
        body = await self._read_body(receive, limit)
        if body is None:
            await self._plain(send, 413, "PAYLOAD_TOO_LARGE", "Payload too large")
            return
        kid = headers.get("x-cp-key-id", "")
        nonce = headers.get("x-cp-nonce", "")
        ts = headers.get("x-cp-timestamp", "")
        key = self._keys.get(kid)
        if key is None or not self._fresh(ts) or not self._nonce_ok(nonce):
            await self._reject(send)
            return
        expected = sign(key, request_string(kid, scope["method"], scope["path"], ts, nonce, body))
        if not hmac.compare_digest(expected, headers.get("x-cp-signature", "")):
            await self._reject(send)
            return
        if not self._nonces.record(nonce):  # only after the signature verified (step 6)
            await self._signed_plain(send, kid, nonce, 503, "WORKER_BUSY", "Worker busy", True)
            return
        await self._dispatch(scope, send, body, key, kid, nonce)

    # --- steps ---

    def _fresh(self, ts: str) -> bool:
        return ts.isdigit() and len(ts) <= 12 and abs(self._clock() - int(ts)) <= WINDOW_SECONDS

    def _nonce_ok(self, nonce: str) -> bool:
        if not (16 <= len(nonce) <= 32 and _B64URL.match(nonce)):
            return False
        try:
            raw = base64.urlsafe_b64decode(nonce + "=" * (-len(nonce) % 4))
        except (binascii.Error, ValueError):
            return False
        return len(raw) == 16 and not self._nonces.seen(nonce)

    @staticmethod
    async def _read_body(receive: Receive, limit: int) -> bytes | None:
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return None
            chunk: bytes = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
            if not message.get("more_body", False):
                return b"".join(chunks)

    async def _dispatch(
        self, scope: Scope, send: Send, body: bytes, key: bytes, kid: str, nonce: str
    ) -> None:
        sent = False

        async def replay() -> Message:
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        status = 500
        resp_headers: list[tuple[bytes, bytes]] = []
        parts: list[bytes] = []

        async def capture(message: Message) -> None:
            nonlocal status, resp_headers
            if message["type"] == "http.response.start":
                status = message["status"]
                resp_headers = list(message.get("headers", []))
            elif message["type"] == "http.response.body":
                parts.append(message.get("body", b""))

        try:
            await self.app(scope, replay, capture)
        except Exception:  # noqa: BLE001 - nothing from the exception leaves the worker
            status, parts = 500, [problem_body(500, "INTERNAL", "Internal error")]
            resp_headers = [(b"content-type", b"application/problem+json")]
        out = b"".join(parts)
        drop = {b"content-length", b"x-cp-key-id", b"x-cp-signature"}
        final = [(k, v) for k, v in resp_headers if k.lower() not in drop]
        final += [
            (b"content-length", str(len(out)).encode()),
            (b"x-cp-key-id", kid.encode()),
            (b"x-cp-signature", sign(key, response_string(kid, nonce, status, out)).encode()),
        ]
        await send({"type": "http.response.start", "status": status, "headers": final})
        await send({"type": "http.response.body", "body": out})

    async def _reject(self, send: Send) -> None:
        # Unsigned and without detail: the caller may not hold the key (ADR 0014 4.2).
        await self._plain(send, 401, "WORKER_AUTH_FAILED", "Unauthorized")

    @staticmethod
    async def _plain(
        send: Send, status: int, code: str, title: str, retry_after: bool = False
    ) -> None:
        body = problem_body(status, code, title)
        headers = [
            (b"content-type", b"application/problem+json"),
            (b"content-length", str(len(body)).encode()),
        ]
        if retry_after:
            headers.append((b"retry-after", b"5"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def _signed_plain(
        self, send: Send, kid: str, nonce: str, status: int, code: str, title: str, retry: bool
    ) -> None:
        body = problem_body(status, code, title)
        sig = sign(self._keys[kid], response_string(kid, nonce, status, body))
        headers = [
            (b"content-type", b"application/problem+json"),
            (b"content-length", str(len(body)).encode()),
            (b"x-cp-key-id", kid.encode()),
            (b"x-cp-signature", sig.encode()),
        ]
        if retry:
            headers.append((b"retry-after", b"5"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
