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
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol
from urllib.parse import parse_qs, urlsplit

FACE_MAX_URL_LIFETIME: Final = 60
ANALYSIS_MAX_URL_LIFETIME: Final = 300
CLOCK_SKEW_SECONDS: Final = 60
MAX_URL_LENGTH: Final = 2048
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


def _amz_epoch(value: str) -> int:
    return calendar.timegm(time.strptime(value, "%Y%m%dT%H%M%SZ"))


def validate_url(
    url: str, cfg: FetchConfig, max_lifetime: int, now: Callable[[], float] = time.time
) -> tuple[str, int, str]:
    """Return (host, port, path-with-query) if the URL is allowed; raise FetchError otherwise."""
    if len(url) > MAX_URL_LENGTH or not url.isascii() or any(c in url for c in "\r\n\t\\ "):
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
            names_bucket = True  # path style
        elif host == f"{cfg.bucket}.{o.host}":
            names_bucket = True  # virtual-hosted style
    if not names_bucket or ".." in parts.path.split("/"):
        raise FetchError("URL_REFUSED")
    query = {k.lower(): v for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
    date, expires = query.get("x-amz-date", [""])[0], query.get("x-amz-expires", [""])[0]
    if not _AMZ_DATE.fullmatch(date) or not _EXPIRES.fullmatch(expires):
        raise FetchError("URL_REFUSED")
    lifetime = int(expires)
    signed_at = _amz_epoch(date)
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
    def read(self, n: int) -> bytes: ...


class _Connection(Protocol):
    def request(self, method: str, target: str, headers: dict[str, str]) -> None: ...
    def getresponse(self) -> _Response: ...
    def close(self) -> None: ...


ConnectionFactory = Callable[[str, str, int, float], _Connection]


class _HttpConnection:
    """The real connection: stdlib http.client, no proxy, no redirect handling."""

    def __init__(self, scheme: str, host: str, port: int, timeout: float) -> None:
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        self._conn = cls(host, port, timeout=timeout)

    def request(self, method: str, target: str, headers: dict[str, str]) -> None:
        self._conn.request(method, target, headers=headers)

    def getresponse(self) -> _Response:
        return self._conn.getresponse()

    def close(self) -> None:
        self._conn.close()


def _default_connection(scheme: str, host: str, port: int, timeout: float) -> _Connection:
    return _HttpConnection(scheme, host, port, timeout)


def fetch(
    url: str,
    cfg: FetchConfig,
    *,
    max_bytes: int,
    max_lifetime: int,
    timeout: float = 10.0,
    now: Callable[[], float] = time.time,
    connection: ConnectionFactory = _default_connection,
) -> bytes:
    """GET the object. No redirects, no proxy, streamed and cut at `max_bytes`."""
    host, port, target = validate_url(url, cfg, max_lifetime, now)
    scheme = urlsplit(url).scheme
    conn = connection(scheme, host, port, timeout)
    try:
        conn.request("GET", target, headers={"Accept-Encoding": "identity"})
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
            chunk = resp.read(64 * 1024)
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
        conn.close()
