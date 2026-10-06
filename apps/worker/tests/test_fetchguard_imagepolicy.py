"""ADR 0014 4.5 fetch guard and 6.2 per-role image caps (FR-403, FR-606; TC-033 path)."""

from __future__ import annotations

import http.client
import io
import time

import pytest
from PIL import Image as PILImage

from worker import fetchguard
from worker.face.imagepolicy import ImagePolicyError, check_image
from worker.fetchguard import FetchConfig, FetchError, Origin

NOW = 1_800_000_000.0
BUCKET = "cp-media"
CFG = FetchConfig((Origin("https", "s3.example.test", 443),), BUCKET)


def amz(ts: float = NOW, expires: int = 60) -> str:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))
    return f"X-Amz-Date={stamp}&X-Amz-Expires={expires}&X-Amz-Signature=abc"


def url(
    host: str = "s3.example.test",
    path: str = f"/{BUCKET}/orgs/o/sessions/s/x.jpg",
    q: str | None = None,
    scheme: str = "https",
) -> str:
    return f"{scheme}://{host}{path}?{q if q is not None else amz()}"


def ok(u: str, lifetime: int = 60) -> tuple[str, int, str]:
    return fetchguard.validate_url(u, CFG, lifetime, lambda: NOW)


def test_fr403_path_style_and_virtual_hosted_urls_naming_the_bucket_are_allowed() -> None:
    assert ok(url())[0] == "s3.example.test"
    assert ok(url(host=f"{BUCKET}.s3.example.test", path="/orgs/o/x.jpg"))[0].startswith(BUCKET)


@pytest.mark.parametrize(
    "bad",
    [
        url(host="evil.test"),
        url(host="s3.example.test:8443"),
        url(scheme="http"),
        url(path="/other-bucket/x.jpg"),
        url(host="other.s3.example.test", path="/x.jpg"),
        url(path=f"/{BUCKET}/../etc/passwd"),
        "https://user:pw@s3.example.test/cp-media/x.jpg?" + amz(),
        url() + "#frag",
        url(q=""),
        url(q="X-Amz-Date=20260101T000000Z"),
        url(q=amz(NOW - 61, 60)),  # expired
        url(q=amz(NOW + 120, 60)),  # signed in the future
        url(q=amz(expires=61)),  # lifetime longer than the face route allows
        url(q=amz(expires=0)),
        "https://s3.example.test/cp-media/x.jpg?" + amz() + "\r\nHost: evil",
        "https://s3.example.test/cp-media/é.jpg?" + amz(),
        "x" * 3000,
        url(host=f"{BUCKET}.s3.example.test.evil.test", path="/x.jpg"),  # suffix trick
        url(host="s3.example.test."),  # trailing dot
        url(host="[::1]"),
        url(host="127.0.0.1"),
        url(path=f"/{BUCKET}/%2e%2e/other-bucket/k"),
        url(path=f"/{BUCKET}/%2E%2E/other-bucket/k"),
        url(path=f"/{BUCKET}/a%2fb"),
        url(path=f"/{BUCKET}//k"),
        url(path=f"/{BUCKET}/./k"),
        url(q=amz().replace("X-Amz-Date=20", "X-Amz-Date=99", 1)),  # signed far in the future
        url(q="X-Amz-Date=20261301T000000Z&X-Amz-Expires=60"),  # month 13
        url(q=amz() + "&x-amz-expires=60"),  # case-variant duplicate
        url(q=amz() + "&X-Amz-Expires=604800"),  # exact duplicate
        url(q=amz().replace("X-Amz-Expires", "x-amz-expires")),  # wrong case
        "https://s3.example.test:443@evil.test/cp-media/x.jpg?" + amz(),
        "https://s3.example.test/cp-media/x\x00.jpg?" + amz(),
        "https://s3.example.test/cp-media/x\x7f.jpg?" + amz(),
    ],
)
def test_fr403_urls_outside_the_allow_list_or_expired_are_refused(bad: str) -> None:
    with pytest.raises(FetchError) as ei:
        ok(bad)
    assert ei.value.code == "URL_REFUSED"
    assert "evil" not in str(ei.value)


def test_fr403_legitimate_encoded_keys_pass_and_encoded_query_keys_cannot_hide_duplicates() -> None:
    for key in ("a%2Bb.jpg", "a%20b.jpg", "100%25.jpg"):
        assert ok(url(path=f"/{BUCKET}/orgs/o/{key}"))[0] == "s3.example.test"
    for extra in (
        "&X-Amz%2DExpires=604800",
        "&X-Amz%2DDate=20200101T000000Z",
        "&x-amz%2dexpires=60",
    ):
        with pytest.raises(FetchError):
            ok(url(q=amz() + extra))
    for path in (f"/{BUCKET}/a%2Fb", f"/{BUCKET}/a%5Cb", f"/{BUCKET}/a%5cb"):
        with pytest.raises(FetchError):
            ok(url(path=path))


def test_fr403_a_bucket_root_without_a_key_is_refused() -> None:
    for u in (url(path=f"/{BUCKET}/"), url(host=f"{BUCKET}.s3.example.test", path="/")):
        with pytest.raises(FetchError):
            ok(u)


def test_fr403_host_case_is_normalised_for_matching() -> None:
    assert ok(url(host="S3.Example.TEST"))[0] == "s3.example.test"


def test_fr403_http_is_allowed_only_when_the_config_allows_it() -> None:
    local = FetchConfig((Origin("http", "localhost", 9000),), BUCKET, allow_http=True)
    u = f"http://localhost:9000/{BUCKET}/x.jpg?{amz()}"
    assert fetchguard.validate_url(u, local, 60, lambda: NOW)[1] == 9000
    with pytest.raises(FetchError):
        fetchguard.validate_url(u, FetchConfig(local.origins, BUCKET, False), 60, lambda: NOW)


def test_fr403_build_config_rules() -> None:
    cfg = fetchguard.build_config("https://s3.example.test", BUCKET, allow_http=False)
    assert cfg.origins[0].port == 443
    for origins, bucket, allow in (
        ("", BUCKET, False),
        ("https://s3.example.test", "BAD_BUCKET", False),
        ("http://localhost:9000", BUCKET, False),
        ("https://user@s3.example.test", BUCKET, False),
        ("ftp://s3.example.test", BUCKET, False),
        ("https://s3.example.test/path", BUCKET, False),
    ):
        with pytest.raises(ValueError):
            fetchguard.build_config(origins, bucket, allow_http=allow)


class FakeResponse:
    def __init__(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self._body = io.BytesIO(body)
        self._headers = headers or {}

    def getheader(self, name: str) -> str | None:
        return self._headers.get(name)

    def read1(self, n: int) -> bytes:
        return self._body.read(n)

    def close(self) -> None:
        return None


class FakeConn:
    requests: list[tuple[str, str]] = []

    def __init__(self, response: FakeResponse | Exception) -> None:
        self.response = response
        self.closed = False
        self.timeouts: list[float] = []

    def set_timeout(self, seconds: float) -> None:
        self.timeouts.append(seconds)

    def request(self, method: str, target: str, headers: dict[str, str]) -> None:
        FakeConn.requests.append((method, target))
        assert headers == {"Accept-Encoding": "identity"}

    def getresponse(self) -> FakeResponse:
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

    def close(self) -> None:
        self.closed = True


def fetch_with(response: FakeResponse | Exception, max_bytes: int = 100) -> bytes:
    FakeConn.requests = []
    conn = FakeConn(response)
    return fetchguard.fetch(
        url(),
        CFG,
        max_bytes=max_bytes,
        max_lifetime=60,
        now=lambda: NOW,
        connection=lambda scheme, host, port, timeout: conn,
    )


def test_fr403_fetch_returns_the_body_and_never_follows_redirects() -> None:
    assert fetch_with(FakeResponse(200, b"abc")) == b"abc"
    for status in (301, 302, 307, 403, 404, 500):
        with pytest.raises(FetchError) as ei:
            fetch_with(FakeResponse(status, b"", {"Location": "https://evil.test/"}))
        assert ei.value.code == "MEDIA_UNAVAILABLE"
        assert len(FakeConn.requests) == 1  # no second request to the Location


def test_fr403_fetch_cuts_oversized_bodies_by_header_and_by_streaming() -> None:
    with pytest.raises(FetchError) as ei:
        fetch_with(FakeResponse(200, b"x", {"Content-Length": "101"}))
    assert ei.value.code == "MEDIA_INVALID"
    with pytest.raises(FetchError) as ei:
        fetch_with(FakeResponse(200, b"x" * 101))
    assert ei.value.code == "MEDIA_INVALID"


def test_fr403_network_errors_are_media_unavailable_without_detail() -> None:
    for err in (OSError("secret-host"), http.client.HTTPException("secret"), TimeoutError()):
        with pytest.raises(FetchError) as ei:
            fetch_with(err)
        assert ei.value.code == "MEDIA_UNAVAILABLE" and "secret" not in str(ei.value)


def jpeg(w: int = 64, h: int = 64, quality: int = 80) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (w, h), (120, 90, 60)).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def test_fr403_id_and_selfie_accept_jpeg_within_5_mib_and_refuse_everything_else() -> None:
    for role in ("ID", "SELFIE"):
        check_image(role, jpeg(2000, 2000))
        for data, code in (
            (b"", f"{role}_IMAGE_SIZE"),
            (b"\xff\xd8\xff" + b"0" * (5 * 1024 * 1024), f"{role}_IMAGE_SIZE"),
            (b"\x89PNG\r\n\x1a\n" + b"0" * 20, f"{role}_NOT_JPEG"),
            (b"\xff\xd8\xff" + b"garbage", f"{role}_IMAGE_CORRUPT"),
        ):
            with pytest.raises(ImagePolicyError) as ei:
                check_image(role, data)
            assert ei.value.code == code


def test_fr606_frame_is_capped_at_1_mib_and_1920_by_1920_from_the_header() -> None:
    check_image("FRAME", jpeg(1920, 1080))
    for data in (jpeg(1921, 100), jpeg(100, 1921), jpeg(4000, 4000)):
        with pytest.raises(ImagePolicyError) as ei:
            check_image("FRAME", data)
        assert ei.value.code == "FRAME_DIMENSIONS"
    noisy = io.BytesIO()
    import numpy as np

    rng = np.random.default_rng(0)
    PILImage.fromarray(rng.integers(0, 255, (1500, 1500, 3), dtype=np.uint8), "RGB").save(
        noisy, format="JPEG", quality=95
    )
    with pytest.raises(ImagePolicyError) as ei:
        check_image("FRAME", noisy.getvalue())
    assert ei.value.code == "FRAME_IMAGE_SIZE"


def test_fr606_frame_size_check_never_decodes_pixels(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(self: object) -> None:
        raise AssertionError("pixels were decoded")

    monkeypatch.setattr("PIL.ImageFile.ImageFile.load", boom)
    check_image("FRAME", jpeg(100, 100))


def test_fr403_real_http_fetch_against_a_local_store_does_not_follow_a_redirect() -> None:
    import http.server
    import threading

    hits: list[str] = []
    port_box: list[int] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            hits.append(self.path.split("?")[0])
            if "/redirect/" in self.path:
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{port_box[0]}/cp-media/leak")
                self.end_headers()
                return
            body = b"hello"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            return

    import socketserver

    class Server(http.server.HTTPServer):
        def server_bind(self) -> None:  # skip getfqdn(), which can take many seconds on macOS
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "127.0.0.1", self.server_address[1]

    server = Server(("127.0.0.1", 0), Handler)
    port_box.append(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_port
        cfg = FetchConfig((Origin("http", "127.0.0.1", port),), BUCKET, allow_http=True)
        base = f"http://127.0.0.1:{port}/{BUCKET}"
        q = amz()
        got = fetchguard.fetch(
            f"{base}/ok.jpg?{q}", cfg, max_bytes=100, max_lifetime=60, now=lambda: NOW
        )
        assert got == b"hello"
        with pytest.raises(FetchError) as ei:
            fetchguard.fetch(
                f"{base}/redirect/x.jpg?{q}", cfg, max_bytes=100, max_lifetime=60, now=lambda: NOW
            )
        assert ei.value.code == "MEDIA_UNAVAILABLE"
        assert "/cp-media/leak" not in hits  # the Location was never requested
    finally:
        server.shutdown()


def test_fr403_a_slow_sender_is_cut_off_by_the_total_deadline() -> None:
    class Slow(FakeResponse):
        def read1(self, n: int) -> bytes:
            ticks.append(1)
            return b"x"

    ticks: list[int] = []
    # the deadline is 5.5 s after the first reading; the third read finds it long past
    clock = iter([0.0, 0.1, 0.2, 0.3, 1.0, 9.0])
    conn = FakeConn(Slow(200, b""))
    with pytest.raises(FetchError) as ei:
        fetchguard.fetch(
            url(),
            CFG,
            max_bytes=10_000,
            max_lifetime=60,
            now=lambda: NOW,
            monotonic=lambda: next(clock),
            connection=lambda scheme, host, port, timeout: conn,
        )
    assert ei.value.code == "MEDIA_UNAVAILABLE" and len(ticks) == 2 and conn.closed


def test_fr606_a_decompression_bomb_is_a_dimension_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    def bomb(*a: object, **k: object) -> None:
        raise PILImage.DecompressionBombError("too big")

    monkeypatch.setattr(PILImage, "open", bomb)
    with pytest.raises(ImagePolicyError) as ei:
        check_image("SELFIE", b"\xff\xd8\xff" + b"0" * 20)
    assert ei.value.code == "SELFIE_DIMENSIONS"


def test_fr403_the_deadline_cuts_a_real_slow_sender_and_limits_each_socket_wait() -> None:
    import http.server
    import socketserver
    import threading

    port_box: list[int] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Length", "100000")
            self.end_headers()
            try:
                for _ in range(400):  # one byte every 0.25 s would take 100 s
                    self.wfile.write(b"x")
                    self.wfile.flush()
                    time.sleep(0.25)
            except OSError:
                return

        def log_message(self, *args: object) -> None:
            return

    class Server(http.server.HTTPServer):
        def server_bind(self) -> None:
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "127.0.0.1", self.server_address[1]

    server = Server(("127.0.0.1", 0), Handler)
    port_box.append(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        cfg = FetchConfig((Origin("http", "127.0.0.1", port_box[0]),), BUCKET, allow_http=True)
        u = f"http://127.0.0.1:{port_box[0]}/{BUCKET}/slow.jpg?{amz(time.time())}"
        started = time.monotonic()
        with pytest.raises(FetchError) as ei:
            fetchguard.fetch(
                u, cfg, max_bytes=200_000, max_lifetime=60, timeout=10.0, total_timeout=0.8
            )
        assert ei.value.code == "MEDIA_UNAVAILABLE"
        assert time.monotonic() - started < 3.0  # not the 10 s socket timeout, nor 100 s
    finally:
        server.shutdown()


def test_fr403_each_socket_wait_is_capped_by_what_is_left_of_the_deadline() -> None:
    conn = FakeConn(FakeResponse(200, b"abc"))
    ticks = iter([0.0, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5])
    fetchguard.fetch(
        url(),
        CFG,
        max_bytes=100,
        max_lifetime=60,
        timeout=10.0,
        total_timeout=5.5,
        now=lambda: NOW,
        monotonic=lambda: next(ticks),
        connection=lambda scheme, host, port, timeout: conn,
    )
    assert (
        conn.timeouts
        and max(conn.timeouts) <= 5.5
        and conn.timeouts == sorted(conn.timeouts, reverse=True)
    )
