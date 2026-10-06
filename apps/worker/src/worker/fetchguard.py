"""Outbound fetch guard for presigned URLs (ADR 0014 4.5).

URLs arrive inside signed bodies but are still treated as untrusted. Only URLs whose scheme, host
and port match the configured object-store origins and that name the configured bucket are
fetched. Redirects are never followed, proxies are never used, the response is streamed and cut at
the byte cap, and an expired URL, or one whose lifetime exceeds the route's limit, is refused.
Errors carry fixed codes only: no URL, host or response text ever appears in them.
"""

from __future__ import annotations

import calendar
import http.client
import re
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol
from urllib.parse import parse_qsl, unquote, urlsplit

FACE_MAX_URL_LIFETIME: Final = 60
ANALYSIS_MAX_URL_LIFETIME: Final = 300
CLOCK_SKEW_SECONDS: Final = 60
MAX_URL_LENGTH: Final = 2048
# Time allowed for one object (the API gives up at 15-20 s). Hard once the body starts; the TLS
# handshake, header parsing and DNS are bounded per socket call only (FU-INB-24).
FACE_FETCH_DEADLINE: Final = 5.5  # two downloads must fit the API's 15 s with room to compute
_AMZ_DATE: Final = re.compile(r"[0-9]{8}T[0-9]{6}Z")
_EXPIRES: Final = re.compile(r"[0-9]{1,7}")
_HOST: Final = re.compile(r"[A-Za-z0-9.-]{1,253}")
_BUCKET: Final = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")


class FetchError(Exception):
    """`URL_REFUSED` (a request bug, 400) or `MEDIA_UNAVAILABLE` / `MEDIA_INVALID` (422)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class Origin:
    scheme: str
    host: str
    port: int


@dataclass(frozen=True, slots=True)
class FetchConfig:
    origins: tuple[Origin, ...]
    bucket: str
    allow_http: bool = False  # only WORKER_ENV=local, for a local S3-compatible store


def parse_origin(text: str) -> Origin:
    parts = urlsplit(text.strip())
    if parts.scheme not in ("https", "http") or not parts.hostname or parts.path not in ("", "/"):
        raise ValueError("bad origin")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("bad origin")
    host = parts.hostname.lower()
    if not _HOST.fullmatch(host):
        raise ValueError("bad origin")
    return Origin(parts.scheme, host, parts.port or (443 if parts.scheme == "https" else 80))


def build_config(origins_env: str, bucket: str, *, allow_http: bool) -> FetchConfig:
    """From `WORKER_OBJECT_STORE_ORIGINS` (comma separated) and `WORKER_OBJECT_STORE_BUCKET`."""
    origins = tuple(parse_origin(o) for o in origins_env.split(",") if o.strip())
    if not origins or not _BUCKET.fullmatch(bucket):
        raise ValueError("object store not configured")
    if not allow_http and any(o.scheme != "https" for o in origins):
        raise ValueError("http origin outside local")
    return FetchConfig(origins, bucket, allow_http)


def _odd_path(path: str) -> bool:
    """Dot segments in any encoding, encoded slashes or backslashes, and empty segments."""
    lowered = path.lower()
    if "%2f" in lowered or "%5c" in lowered or "//" in path:
        return True
    return any(seg in (".", "..") for seg in unquote(path).split("/"))


def _amz_epoch(value: str) -> int:
    return calendar.timegm(time.strptime(value, "%Y%m%dT%H%M%SZ"))


def validate_url(
    url: str, cfg: FetchConfig, max_lifetime: int, now: Callable[[], float] = time.time
) -> tuple[str, int, str]:
    """Return (host, port, path-with-query) if the URL is allowed; raise FetchError otherwise."""
    if (
        len(url) > MAX_URL_LENGTH
        or not url.isascii()
        or any(ord(c) < 0x21 or ord(c) == 0x7F or c == "\\" for c in url)
    ):
        raise FetchError("URL_REFUSED")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise FetchError("URL_REFUSED") from None
    if parts.username is not None or parts.password is not None or parts.fragment:
        raise FetchError("URL_REFUSED")
    scheme, host = parts.scheme, (parts.hostname or "").lower()
    port = port or (443 if scheme == "https" else 80)
    if scheme == "http" and not cfg.allow_http:
        raise FetchError("URL_REFUSED")
    names_bucket = False
    for o in cfg.origins:
        if (o.scheme, o.port) != (scheme, port):
            continue
        if host == o.host and parts.path.startswith(f"/{cfg.bucket}/"):
            names_bucket = len(parts.path) > len(cfg.bucket) + 2  # path style: a key must follow
        elif host == f"{cfg.bucket}.{o.host}":
            names_bucket = parts.path not in ("", "/")  # virtual-hosted: a key must follow
    if not names_bucket or _odd_path(parts.path):
        raise FetchError("URL_REFUSED")
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    folded = [k.lower() for k, _ in pairs]
    if len(set(folded)) != len(
        folded
    ):  # duplicates or case variants: the guard and S3 could differ
        raise FetchError("URL_REFUSED")
    query = dict(pairs)
    date, expires = query.get("X-Amz-Date", ""), query.get("X-Amz-Expires", "")
    if not _AMZ_DATE.fullmatch(date) or not _EXPIRES.fullmatch(expires):
        raise FetchError("URL_REFUSED")
    lifetime = int(expires)
    try:
        signed_at = _amz_epoch(date)
    except (ValueError, OverflowError):
        raise FetchError("URL_REFUSED") from None
    t = now()
    if lifetime < 1 or lifetime > max_lifetime:
        raise FetchError("URL_REFUSED")
    if signed_at > t + CLOCK_SKEW_SECONDS or t > signed_at + lifetime:
        raise FetchError("URL_REFUSED")
    target = parts.path + ("?" + parts.query if parts.query else "")
    return host, port, target


class _Response(Protocol):
    status: int

    def getheader(self, name: str) -> str | None: ...
    def read1(self, n: int) -> bytes: ...
    def close(self) -> None: ...


class _Connection(Protocol):
    def set_timeout(self, seconds: float) -> None: ...
    def request(self, method: str, target: str, headers: dict[str, str]) -> None: ...
    def getresponse(self) -> _Response: ...
    def close(self) -> None: ...


ConnectionFactory = Callable[[str, str, int, float], _Connection]


class _HttpConnection:
    """The real connection: stdlib http.client, no proxy, no redirect handling.

    `http.client` hands the socket to the response once the server says it will close the
    connection, so the socket is kept here: timeouts must reach it for the whole download.
    """

    def __init__(self, scheme: str, host: str, port: int, timeout: float) -> None:
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        self._conn = cls(host, port, timeout=timeout)
        self._sock: socket.socket | None = None

    def set_timeout(self, seconds: float) -> None:
        self._conn.timeout = seconds
        if self._sock is not None:
            try:
                self._sock.settimeout(seconds)
            except OSError:
                pass  # the response already read everything and closed the socket

    def request(self, method: str, target: str, headers: dict[str, str]) -> None:
        self._conn.connect()
        self._sock = self._conn.sock
        self._conn.request(method, target, headers=headers)

    def getresponse(self) -> _Response:
        return self._conn.getresponse()

    def close(self) -> None:
        self._conn.close()
        if self._sock is not None:
            self._sock.close()  # the response may have taken ownership of the socket


def _default_connection(scheme: str, host: str, port: int, timeout: float) -> _Connection:
    return _HttpConnection(scheme, host, port, timeout)


def fetch(
    url: str,
    cfg: FetchConfig,
    *,
    max_bytes: int,
    max_lifetime: int,
    timeout: float = 10.0,
    total_timeout: float = FACE_FETCH_DEADLINE,
    now: Callable[[], float] = time.time,
    monotonic: Callable[[], float] = time.monotonic,
    connection: ConnectionFactory = _default_connection,
) -> bytes:
    """GET the object. No redirects, no proxy, streamed and cut at `max_bytes`."""
    host, port, target = validate_url(url, cfg, max_lifetime, now)
    scheme = urlsplit(url).scheme
    deadline = monotonic() + total_timeout

    def remaining() -> float:
        left = deadline - monotonic()
        if left <= 0:  # a slow sender must not hold a worker slot past the deadline
            raise FetchError("MEDIA_UNAVAILABLE")
        return min(timeout, left)

    conn = connection(scheme, host, port, min(timeout, total_timeout))
    resp: _Response | None = None
    try:
        conn.set_timeout(remaining())
        conn.request("GET", target, headers={"Accept-Encoding": "identity"})
        conn.set_timeout(remaining())
        resp = conn.getresponse()
        if resp.status != 200:  # 3xx included: redirects are not followed
            raise FetchError("MEDIA_UNAVAILABLE")
        declared = resp.getheader("Content-Length")
        if declared is not None and declared.isascii() and declared.isdigit():
            if int(declared) > max_bytes:
                raise FetchError("MEDIA_INVALID")
        chunks: list[bytes] = []
        size = 0
        while True:
            conn.set_timeout(remaining())  # each recv gets only what is left of the deadline
            chunk = resp.read1(64 * 1024)  # at most one recv, so the deadline is checked often
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise FetchError("MEDIA_INVALID")
            chunks.append(chunk)
        return b"".join(chunks)
    except FetchError:
        raise
    except (OSError, http.client.HTTPException):
        raise FetchError("MEDIA_UNAVAILABLE") from None
    finally:
        if resp is not None:
            resp.close()
        conn.close()
