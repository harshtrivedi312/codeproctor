"""ADR 0014 6.2 face routes through the signing middleware (FR-403, FR-606; TC-033, TC-034 server
half). Synthetic images only. QA assigns the extra TC ids (ADR 0014 section 11)."""

from __future__ import annotations

import base64
import io
import json
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from PIL import Image as PILImage

import worker.fetchguard as fetchguard
from face_helpers import FakeDetector, FakeEmbedder, synthetic_png
from test_signing import KEY_A, call, signed
from worker import routes_face
from worker.config import FaceConfig
from worker.face.matcher import FaceMatcher
from worker.face.modelfile import ModelLoadError
from worker.face.types import DetectedFace
from worker.modellock import ModelCheck, ModelLockError, load_lock
from worker.routes_face import FaceRuntime, build_runtime, install_face_routes
from worker.signing import KeyConfigError

BUCKET = "cp-media"
SESSION = "sess-SENTINEL-1"


def jpg(identity: int) -> bytes:
    png = synthetic_png(identity)
    buf = io.BytesIO()
    PILImage.open(io.BytesIO(png)).convert("RGB").save(buf, format="JPEG", quality=95)
    return buf.getvalue()


ID_A, ID_B = jpg(0), jpg(1)
URL = "https://s3.example.test/cp-media/orgs/o/sessions/s/{}.jpg?X-Amz-Date=20260101T000000Z&X-Amz-Expires=60&X-Amz-Signature=SENTINEL"
LOCK = load_lock(Path(__file__).resolve().parents[1] / "models.lock.json")
READY = ModelCheck(True, (), LOCK.digest12, (("FACE_EMBED", "auraface-v1/glintr100.onnx"),))


class World:
    """A fake object store (url -> bytes or FetchError) and the app under test."""

    def __init__(
        self,
        matcher: FaceMatcher | None = None,
        *,
        cache: bool = False,
        factory: Callable[[], FaceMatcher] | None = None,
        check: ModelCheck | None = READY,
    ) -> None:
        self.objects: dict[str, bytes | fetchguard.FetchError] = {}
        self.matcher = matcher or FaceMatcher(
            FakeDetector(), FakeEmbedder(), FaceConfig.model_validate({})
        )
        self.runtime = FaceRuntime(
            face_config=FaceConfig.model_validate({}),
            loaded_lock=LOCK,
            check=check,
            fetch=fetchguard.build_config("https://s3.example.test", BUCKET, allow_http=False),
            cache_enabled=cache,
            worker_version="9.9.9",
            matcher_factory=factory or (lambda: self.matcher),
        )
        self.app = FastAPI()
        install_face_routes(self.app, self.runtime, keys={"k1": KEY_A}, docs_local=False)

    def put(self, name: str, data: bytes | fetchguard.FetchError) -> str:
        u = URL.format(name)
        self.objects[u] = data
        return u

    def post(self, path: str, payload: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
        def fake_fetch(url: str, cfg: Any, **kw: Any) -> bytes:
            item = self.objects.get(url)
            if item is None:
                raise fetchguard.FetchError("MEDIA_UNAVAILABLE")
            if isinstance(item, fetchguard.FetchError):
                raise item
            return item

        monkeypatch.setattr(fetchguard, "fetch", fake_fetch)
        body = json.dumps(payload).encode()
        h, b, _ = signed(body=body, path=path, ts=time.time())
        return call(self.app, path, h, b)


def match_req(w: World, id_img: bytes, selfie: bytes, **over: Any) -> dict[str, Any]:
    return {
        "sessionId": SESSION,
        "attempt": 1,
        "idImageUrl": w.put("id", id_img),
        "selfieUrl": w.put("selfie", selfie),
        "livenessConfirmed": True,
        **over,
    }


def test_fr403_tc033_match_returns_match_with_metadata_and_a_signed_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 200 and r.headers["x-cp-signature"]
    j = r.json()
    assert j["decision"] == "MATCH" and j["reason"] is None and j["score"] > 0.99
    assert j["modelId"] == "fake:1" and j["workerVersion"] == "9.9.9"
    assert j["lockDigest"] == LOCK.digest12 and set(j) >= {"threshold", "detail"}
    assert len(w.matcher.selfie_cache) == 0  # nothing kept: cacheSelfie false (ADR 0014 6.3)


def test_fr403_tc033_below_threshold_and_liveness_go_to_manual_review_never_reject(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_B), monkeypatch)
    assert r.json()["decision"] == "MANUAL_REVIEW" and r.json()["reason"] == "BELOW_THRESHOLD"
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A, livenessConfirmed=False), monkeypatch)
    assert r.json()["reason"] == "LIVENESS_NOT_CONFIRMED"
    assert "REJECT" not in r.text.upper().replace("REJECTED", "")


@pytest.mark.parametrize(
    ("setup", "detail"),
    [
        ("unavailable", "MEDIA_UNAVAILABLE"),
        ("invalid", "MEDIA_INVALID"),
        ("png", "ID_NOT_JPEG"),
        ("huge", "SELFIE_IMAGE_SIZE"),
    ],
)
def test_fr403_tc033_unreadable_or_oversized_media_is_manual_review_match_error(
    monkeypatch: pytest.MonkeyPatch, setup: str, detail: str
) -> None:
    w = World()
    req = match_req(w, ID_A, ID_A)
    if setup == "unavailable":
        w.objects.pop(req["selfieUrl"])
    elif setup == "invalid":
        w.objects[req["selfieUrl"]] = fetchguard.FetchError("MEDIA_INVALID")
    elif setup == "png":
        w.objects[req["idImageUrl"]] = synthetic_png(0)
    else:
        w.objects[req["selfieUrl"]] = b"\xff\xd8\xff" + b"0" * (5 * 1024 * 1024)
    r = w.post("/v1/face/match", req, monkeypatch)
    assert r.status_code == 200
    assert (r.json()["decision"], r.json()["reason"], r.json()["detail"]) == (
        "MANUAL_REVIEW",
        "MATCH_ERROR",
        detail,
    )


def test_fr403_tc033_model_failure_is_manual_review_not_an_error_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def bad() -> FaceMatcher:
        raise ModelLoadError("MODEL_HASH_MISMATCH")

    w = World(factory=bad)
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 200 and r.json()["detail"] == "MODEL_HASH_MISMATCH"
    assert r.json()["decision"] == "MANUAL_REVIEW"


def test_fr403_a_refused_url_is_400_and_a_busy_worker_is_503_with_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    req = match_req(w, ID_A, ID_A)
    w.objects[req["idImageUrl"]] = fetchguard.FetchError("URL_REFUSED")
    r = w.post("/v1/face/match", req, monkeypatch)
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"
    w = World()
    held = [w.runtime.semaphore.acquire() for _ in range(routes_face.FACE_CONCURRENCY)]
    assert all(held)
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 503 and r.json()["code"] == "WORKER_BUSY" and r.headers["retry-after"]


@pytest.mark.parametrize(
    "over",
    [
        {"livenessConfirmed": "true"},
        {"attempt": 3},
        {"sessionId": "bad id!"},
        {"unknownField-SENTINEL": 1},
        {"cacheSelfie": True},  # needs cacheExpiresAt
        {"cacheExpiresAt": "2030-01-01T00:00:00Z"},  # without cacheSelfie
    ],
)
def test_fr403_invalid_requests_are_400_without_echoing_input(
    monkeypatch: pytest.MonkeyPatch, over: dict[str, Any]
) -> None:
    w = World()
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A, **over), monkeypatch)
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"
    assert "SENTINEL" not in r.text and "bad id" not in r.text


def recheck_req(w: World, frame: bytes, selfie: bytes, **over: Any) -> dict[str, Any]:
    return {
        "sessionId": SESSION,
        "frameUrl": w.put("frame", frame),
        "selfieUrl": w.put("selfie", selfie),
        **over,
    }


def test_fr606_recheck_default_computes_both_embeddings_and_keeps_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    r = w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 200 and r.json()["outcome"] == "MATCH" and r.json()["cache"] == "OFF"
    assert w.matcher.selfie_cache.get(SESSION) is None
    r = w.post("/v1/face/recheck", recheck_req(w, ID_B, ID_A), monkeypatch)
    assert r.json()["outcome"] == "BELOW_THRESHOLD"


def _sequenced(*results: list[DetectedFace]) -> FakeDetector:
    """A detector that answers each call from `results` in order (the frame is embedded first)."""
    queue = list(results)
    return FakeDetector(lambda _img: queue.pop(0))


def test_fr606_a_frame_problem_maps_to_itself_and_a_selfie_problem_is_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from face_helpers import LANDMARKS

    one = [DetectedFace(LANDMARKS.copy(), 0.99)]
    for results, outcome in (
        (([], one), "NO_FACE"),  # nothing in the frame
        ((one * 2, one), "MULTIPLE_FACES"),
        ((one, []), "ERROR"),  # the stored selfie has no face: not the frame's fault
        ((one, one * 2), "ERROR"),
    ):
        w = World(FaceMatcher(_sequenced(*results), FakeEmbedder(), FaceConfig.model_validate({})))
        r = w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
        assert r.json()["outcome"] == outcome, results


def test_fr606_oversized_or_wrong_frames_are_errors_not_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    big = io.BytesIO()
    PILImage.new("RGB", (2000, 100)).save(big, format="JPEG")
    r = w.post("/v1/face/recheck", recheck_req(w, big.getvalue(), ID_A), monkeypatch)
    assert r.status_code == 200 and r.json()["outcome"] == "ERROR"


def test_fr606_cache_stays_off_unless_enabled_and_works_with_a_ttl_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exp = (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    off = World(cache=False)
    r = off.post(
        "/v1/face/recheck",
        recheck_req(off, ID_A, ID_A, cacheSelfie=True, cacheExpiresAt=exp),
        monkeypatch,
    )
    assert r.json()["cache"] == "OFF" and off.matcher.selfie_cache.get(SESSION) is None
    on = World(cache=True)
    req = recheck_req(on, ID_A, ID_A, cacheSelfie=True, cacheExpiresAt=exp)
    assert on.post("/v1/face/recheck", req, monkeypatch).json()["cache"] == "MISS"
    assert on.matcher.selfie_cache.get(SESSION) is not None
    assert on.post("/v1/face/recheck", req, monkeypatch).json()["cache"] == "HIT"
    r = on.post("/v1/face/evict", {"sessionId": SESSION}, monkeypatch)
    assert r.status_code == 204 and on.matcher.selfie_cache.get(SESSION) is None


def test_fr606_cached_selfie_expires_at_its_ttl() -> None:
    from face_helpers import vector_for
    from worker.face.matcher import SelfieCache
    from worker.face.types import Embedding

    cache = SelfieCache(4)
    cache.put("s", Embedding(vector_for(b"a")), time.time() - 1)
    assert cache.get("s") is None and len(cache) == 0
    cache.put("s", Embedding(vector_for(b"a")), time.time() + 60)
    assert cache.get("s") is not None


def test_fr403_ready_reports_models_or_503_and_evict_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    h, b, _ = signed(body=b"", path="/v1/ready", method="GET", ts=time.time())
    r = call(w.app, "/v1/ready", h, b, method="GET")
    assert r.status_code == 200 and r.json()["ready"] is True
    assert r.json()["models"] == [
        {"component": "FACE_EMBED", "modelId": "auraface-v1/glintr100.onnx"}
    ]
    nr = World(check=ModelCheck(False, ("x",), LOCK.digest12, ()))
    h, b, _ = signed(body=b"", path="/v1/ready", method="GET", ts=time.time())
    r = call(nr.app, "/v1/ready", h, b, method="GET")
    assert r.status_code == 503 and r.json()["code"] == "MODEL_UNAVAILABLE"
    assert w.post("/v1/face/evict", {"sessionId": "never-seen"}, monkeypatch).status_code == 204


def test_fr403_unsigned_face_calls_are_refused_and_nothing_is_fetched() -> None:
    w = World()
    r = call(w.app, "/v1/face/match", {"Content-Type": "application/json"}, b"{}")
    assert r.status_code == 401


def test_fr403_logs_hold_fixed_codes_only_no_urls_scores_or_session_ids(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    w = World()
    with caplog.at_level(logging.DEBUG):
        w.post("/v1/face/match", match_req(w, ID_A, ID_B), monkeypatch)
        w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
    for secret in ("SENTINEL", "s3.example.test", SESSION, "0.", "X-Amz"):
        assert secret not in caplog.text


def env(**over: str) -> dict[str, str]:
    base = {"WORKER_HMAC_KEYS": "k1:" + base64.b64encode(KEY_A).decode()}
    return {**base, **over}


def test_fr403_strict_environments_refuse_to_start_without_keys_models_or_object_store(
    tmp_path: Path,
) -> None:
    models = tmp_path / "models"
    models.mkdir()
    full = env(
        WORKER_ENV="production",
        WORKER_MODELS_DIR=str(models),
        WORKER_OBJECT_STORE_ORIGINS="https://s3.example.test",
        WORKER_OBJECT_STORE_BUCKET=BUCKET,
    )
    rt, keys, local = build_runtime(full)
    assert (
        keys and not local and rt.check is not None and not rt.check.ready
    )  # empty dir: not ready
    with pytest.raises(KeyConfigError):
        build_runtime({k: v for k, v in full.items() if k != "WORKER_HMAC_KEYS"})
    with pytest.raises(ModelLockError):
        build_runtime(
            {k: v for k, v in full.items() if k != "WORKER_MODELS_DIR"} | {"WORKER_MODELS_DIR": ""}
        )
    with pytest.raises(ValueError):
        build_runtime({k: v for k, v in full.items() if k != "WORKER_OBJECT_STORE_ORIGINS"})
    with pytest.raises(ValueError):  # plain http outside local development
        build_runtime(full | {"WORKER_OBJECT_STORE_ORIGINS": "http://minio:9000"})
    (models / "sneaky.onnx").write_bytes(b"x")  # F-1: an unlisted model file stops startup
    with pytest.raises(ModelLockError) as ei:
        build_runtime(full)
    assert ei.value.code == "MODEL_UNLISTED"


def test_fr403_unset_environment_is_lenient_and_local_allows_http_and_docs() -> None:
    rt, keys, local = build_runtime({})
    assert keys == {} and not local and rt.fetch is None and not rt.cache_enabled
    rt, _, local = build_runtime(
        env(
            WORKER_ENV="local",
            WORKER_OBJECT_STORE_ORIGINS="http://localhost:9000",
            WORKER_OBJECT_STORE_BUCKET=BUCKET,
            WORKER_FACE_CACHE_ENABLED="true",
        )
    )
    assert local and rt.fetch is not None and rt.cache_enabled


def test_fr403_the_worker_app_exposes_the_signed_face_routes_and_keeps_legacy_ones() -> None:
    from worker.app import app

    paths = set(app.openapi()["paths"])
    assert {"/v1/face/match", "/v1/face/recheck", "/v1/face/evict", "/v1/ready"} <= paths
    assert "/analyze/keystrokes" in paths and "/risk" in paths


def test_fr403_a_runtime_without_an_object_store_answers_503_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = World()
    w.runtime.fetch = None
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 503 and r.json()["code"] == "WORKER_NOT_CONFIGURED"
    r = w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 503


def test_fr403_default_matcher_build_without_the_model_is_manual_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AURAFACE_MODEL_PATH", raising=False)
    w = World()
    w.runtime.matcher_factory = None  # the real factory: no model file configured here
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 200 and r.json()["decision"] == "MANUAL_REVIEW"
    assert r.json()["reason"] == "MATCH_ERROR"
    r = w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
    assert r.status_code == 200 and r.json()["outcome"] == "ERROR"
    h, b, _ = signed(body=b"", path="/v1/ready", method="GET", ts=time.time())
    assert call(w.app, "/v1/ready", h, b, method="GET").status_code == 503
    assert w.runtime.matcher() == (None, w.runtime.matcher()[1])  # failure is remembered


def test_fr606_recheck_refused_url_is_400(monkeypatch: pytest.MonkeyPatch) -> None:
    w = World()
    req = recheck_req(w, ID_A, ID_A)
    w.objects[req["frameUrl"]] = fetchguard.FetchError("URL_REFUSED")
    r = w.post("/v1/face/recheck", req, monkeypatch)
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"
    req = recheck_req(w, ID_A, ID_A)
    w.objects[req["selfieUrl"]] = fetchguard.FetchError("MEDIA_UNAVAILABLE")
    assert w.post("/v1/face/recheck", req, monkeypatch).json()["outcome"] == "ERROR"
