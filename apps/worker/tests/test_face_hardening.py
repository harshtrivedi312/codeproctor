"""Hardening of the face-match module: images, ghost portraits, landmarker file, concurrency."""

from __future__ import annotations

import copy
import hashlib
import io
import pickle
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image as PILImage

from face_helpers import (
    LANDMARKS,
    FakeDetector,
    FakeEmbedder,
    FixedEmbedder,
    synthetic_png,
    to_array,
)
from worker.config import FaceConfig
from worker.face import FaceDecision, FaceMatcher, ReviewReason
from worker.face import detector as det
from worker.face.align import align_face
from worker.face.matcher import SelfieCache, decode_image, review_for_model_error
from worker.face.modelfile import ModelLoadError
from worker.face.types import AlignedFace, DetectedFace, Embedding, Image

ID_A, ID_B = synthetic_png(0), synthetic_png(1)
CFG = FaceConfig()


# ---------- S4: MPO ----------


def test_fr403_s4_mpo_phone_jpeg_is_accepted_and_frame_zero_is_used() -> None:
    first = PILImage.new("RGB", (30, 20), (200, 0, 0))
    second = PILImage.new("RGB", (30, 20), (0, 0, 200))
    buf = io.BytesIO()
    first.save(buf, format="MPO", save_all=True, append_images=[second])
    with PILImage.open(io.BytesIO(buf.getvalue())) as probe:
        assert probe.format == "MPO" and getattr(probe, "n_frames", 0) == 2
    px = decode_image(buf.getvalue(), CFG)
    assert px.shape == (20, 30, 3) and px[0, 0, 0] > 150 and px[0, 0, 2] < 80


# ---------- S5: EXIF orientation ----------


def test_fr403_s5_exif_orientation_6_is_applied_after_the_size_check() -> None:
    im = PILImage.new("RGB", (40, 20), (255, 255, 255))
    for x in range(8):
        for y in range(8):
            im.putpixel((x, y), (255, 0, 0))  # top-left marker block
    exif = im.getexif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display upright
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=exif, quality=100)
    px = decode_image(buf.getvalue(), CFG)
    assert px.shape == (40, 20, 3)  # width and height swapped
    assert px[3, 16, 0] > 200 and px[3, 16, 1] < 120  # block moved to the top-right
    assert px[3, 3, 1] > 200  # and the old corner is white now


def test_fr403_s5_oversized_pixels_are_refused_before_any_transpose() -> None:
    im = PILImage.new("RGB", (40, 20))
    exif = im.getexif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=exif)
    from worker.face.matcher import ImageError

    with pytest.raises(ImageError, match="IMAGE_SIZE"):
        decode_image(buf.getvalue(), FaceConfig(max_image_pixels=500))


# ---------- S7: ghost portrait ----------


def scaled(factor: float, dx: float = 0.0) -> np.ndarray:
    centre = LANDMARKS.mean(axis=0)
    return ((LANDMARKS - centre) * factor + centre + [dx, 0]).astype(np.float32)


class Capture(FakeEmbedder):
    def __init__(self) -> None:
        super().__init__()
        self.crops: list[np.ndarray] = []

    def embed(self, aligned: AlignedFace) -> Embedding:
        self.crops.append(aligned.pixels)
        return super().embed(aligned)


def two_faces(small_factor: float) -> FakeDetector:
    return FakeDetector(
        [DetectedFace(scaled(small_factor, dx=-70), 0.9), DetectedFace(LANDMARKS.copy(), 0.99)]
    )


def ghost_on_id_only(small_factor: float) -> FakeDetector:
    """The first image (the ID) shows a ghost portrait; later images show one face."""
    state = {"n": 0}

    def detect(_image: Image) -> list[DetectedFace]:
        state["n"] += 1
        if state["n"] == 1:
            return [
                DetectedFace(scaled(small_factor, -70), 0.9),
                DetectedFace(LANDMARKS.copy(), 0.99),
            ]
        return [DetectedFace(LANDMARKS.copy(), 0.99)]

    return FakeDetector(detect)


def test_fr403_s7_id_photo_with_a_small_ghost_portrait_uses_the_largest_face() -> None:
    cap = Capture()
    m = FaceMatcher(ghost_on_id_only(0.3), cap)
    r = m.match(ID_A, ID_A)
    assert r.decision is FaceDecision.MATCH
    expected = align_face(to_array(ID_A), LANDMARKS).pixels
    assert np.array_equal(cap.crops[0], expected)  # the large face, not the ghost listed first


def test_fr403_s7_id_photo_with_two_comparable_faces_is_multiple_faces() -> None:
    r = FaceMatcher(two_faces(0.8), FakeEmbedder()).match(ID_A, ID_A)
    assert r.decision is FaceDecision.MANUAL_REVIEW
    assert r.reason is ReviewReason.MULTIPLE_FACES and r.detail == "ID_MULTIPLE_FACES"


def test_fr403_s7_selfie_and_recheck_frames_stay_strictly_single_face() -> None:
    class PerImage:
        """Single face on the ID image, ghost-sized second face on every later image."""

        def __init__(self) -> None:
            self.n = 0

        def __call__(self, _image: Image) -> list[DetectedFace]:
            self.n += 1
            if self.n == 1:
                return [DetectedFace(LANDMARKS.copy(), 0.99)]
            return [DetectedFace(scaled(0.3, -70), 0.9), DetectedFace(LANDMARKS.copy(), 0.99)]

    m = FaceMatcher(FakeDetector(PerImage()), FakeEmbedder())
    r = m.match(ID_A, ID_A, session_id="s")
    assert r.reason is ReviewReason.MULTIPLE_FACES and r.detail == "SELFIE_MULTIPLE_FACES"
    m.selfie_cache.put("s", Embedding(np.ones(512, dtype=np.float32)))
    rc = m.recheck("s", ID_A)
    assert rc.reason is ReviewReason.MULTIPLE_FACES and rc.detail == "FRAME_MULTIPLE_FACES"


def test_fr403_s7_ratio_is_configurable() -> None:
    strict = FaceConfig(id_secondary_face_ratio=0.2)
    r = FaceMatcher(ghost_on_id_only(0.3), FakeEmbedder(), strict).match(ID_A, ID_A)
    assert r.reason is ReviewReason.MULTIPLE_FACES


# ---------- N1 / N2 / N6 / N7 ----------


def test_fr403_n1_detail_codes_name_the_image_role() -> None:
    m = FaceMatcher(FakeDetector([]), FakeEmbedder())
    assert m.match(ID_A, ID_B).detail == "ID_NO_FACE"
    selfie_only_bad = FaceMatcher(FakeDetector(_ok_then_empty()), FakeEmbedder())
    assert selfie_only_bad.match(ID_A, ID_B).detail == "SELFIE_NO_FACE"
    assert m.match(ID_A, b"x" * 20).detail == "ID_NO_FACE"  # ID is checked first
    assert FaceMatcher(FakeDetector(), FakeEmbedder()).match(ID_A, b"junk").detail == (
        "SELFIE_IMAGE_FORMAT_OR_CORRUPT"
    )


def _ok_then_empty() -> Any:
    state = {"n": 0}

    def fn(_image: Image) -> list[DetectedFace]:
        state["n"] += 1
        return [DetectedFace(LANDMARKS.copy(), 0.99)] if state["n"] == 1 else []

    return fn


def test_fr403_n2_degenerate_landmarks_get_a_fixed_code_and_log_only_the_type(
    caplog: pytest.LogCaptureFixture,
) -> None:
    flat = np.ones((5, 2), dtype=np.float32) * 7.5
    m = FaceMatcher(FakeDetector([DetectedFace(flat, 0.99)]), FakeEmbedder())
    r = m.match(ID_A, ID_B)
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "ID_DEGENERATE_LANDMARKS"
    assert "7.5" not in caplog.text


def test_adr0004_n6_aligned_face_cannot_be_pickled_or_copied() -> None:
    a = AlignedFace(np.zeros((112, 112, 3), dtype=np.uint8))
    for fn in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            fn(a)


def test_fr606_n7_selfie_is_cached_only_after_a_successful_compare() -> None:
    m = FaceMatcher(FakeDetector(), FixedEmbedder([[1.0, 2.0], [1.0, 2.0, 3.0]]))
    assert m.match(ID_A, ID_B, session_id="s").detail == "DIM_MISMATCH"
    assert len(m.selfie_cache) == 0
    ok = FaceMatcher(FakeDetector(), FixedEmbedder([[1.0, 0.0], [0.0, 1.0]]))
    assert ok.match(ID_A, ID_B, session_id="s").decision is FaceDecision.MANUAL_REVIEW
    assert len(ok.selfie_cache) == 1  # a below-threshold score is still a successful compare


# ---------- S3: concurrency ----------


def test_fr606_s3_selfie_cache_is_safe_under_concurrent_use() -> None:
    cache = SelfieCache(8)
    emb = Embedding(np.ones(4, dtype=np.float32))
    errors: list[BaseException] = []

    def worker(n: int) -> None:
        try:
            for i in range(300):
                sid = f"s{(n * 7 + i) % 40}"
                cache.put(sid, emb)
                cache.get(sid)
                if i % 5 == 0:
                    cache.clear_session(sid)
                assert len(cache) <= 8
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == [] and len(cache) <= 8
    cache.clear()
    assert len(cache) == 0


# ---------- S6: landmarker file and detector ----------


def fake_factory(record: dict[str, Any], landmarks: list[list[tuple[float, float]]] | None = None):  # type: ignore[no-untyped-def]
    def factory(model: bytes, min_conf: float, max_faces: int):  # type: ignore[no-untyped-def]
        record.update(
            model=model, min_conf=min_conf, max_faces=max_faces, calls=record.get("calls", 0) + 1
        )
        return lambda _image: landmarks or []

    return factory


@pytest.fixture
def landmarker_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "face_landmarker.task"
    p.write_bytes(b"synthetic landmarker placeholder")
    monkeypatch.setattr(det, "LANDMARKER_SHA256", hashlib.sha256(p.read_bytes()).hexdigest())
    return p


def test_fr403_s6_landmarker_pin_is_the_full_adr_digest() -> None:
    assert (
        det.LANDMARKER_SHA256 == "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
    )
    assert det.LANDMARKER_FILE_NAME == "face_landmarker.task"


def test_fr403_s6_verified_bytes_and_confidence_floor_reach_the_landmarker(
    landmarker_file: Path,
) -> None:
    rec: dict[str, Any] = {}
    det.MediaPipeDetector.from_file(landmarker_file, 0.7, fake_factory(rec))
    assert rec["model"] == landmarker_file.read_bytes() and rec["min_conf"] == 0.7  # N3
    assert rec["max_faces"] == det.MAX_FACES


def test_fr403_s6_hash_mismatch_wrong_name_and_unset_env_never_reach_the_landmarker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rec: dict[str, Any] = {}
    bad = tmp_path / "face_landmarker.task"
    bad.write_bytes(b"tampered")
    with pytest.raises(ModelLoadError, match="MODEL_HASH_MISMATCH") as e:
        det.MediaPipeDetector.from_file(bad, 0.7, fake_factory(rec))
    wrong = tmp_path / "blaze_face_short_range.tflite"
    wrong.write_bytes(b"x")
    with pytest.raises(ModelLoadError, match="WRONG_MODEL_FILE_NAME"):
        det.MediaPipeDetector.from_file(wrong, 0.7, fake_factory(rec))
    monkeypatch.delenv(det.LANDMARKER_PATH_ENV, raising=False)
    with pytest.raises(ModelLoadError, match="MODEL_PATH_NOT_SET"):
        det.MediaPipeDetector.from_env(0.7, fake_factory(rec))
    assert rec == {}
    r = review_for_model_error(e.value)  # the candidate is routed to a human, not failed
    assert r.decision is FaceDecision.MANUAL_REVIEW and r.reason is ReviewReason.MATCH_ERROR


def test_fr403_s6_from_env_and_factory_failure(
    landmarker_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(det.LANDMARKER_PATH_ENV, str(landmarker_file))
    assert (
        det.MediaPipeDetector.from_env(0.7, fake_factory({})).detect(
            np.zeros((10, 10, 3), dtype=np.uint8)
        )
        == []
    )

    def boom(_m: bytes, _c: float, _n: int):  # type: ignore[no-untyped-def]
        raise RuntimeError("secret /path")

    with pytest.raises(ModelLoadError, match="MODEL_LOAD_FAILED") as e:
        det.MediaPipeDetector.from_file(landmarker_file, 0.7, boom)
    assert "secret" not in str(e.value)


def test_fr403_s6_detect_maps_mesh_indices_to_five_pixel_points(landmarker_file: Path) -> None:
    mesh = [(0.0, 0.0)] * 478
    mesh[33], mesh[133] = (0.2, 0.4), (0.4, 0.4)
    mesh[362], mesh[263] = (0.6, 0.4), (0.8, 0.4)
    mesh[1] = (0.5, 0.6)
    mesh[61], mesh[291] = (0.35, 0.8), (0.65, 0.8)
    d = det.MediaPipeDetector.from_file(landmarker_file, 0.7, fake_factory({}, [mesh]))
    (face,) = d.detect(np.zeros((100, 200, 3), dtype=np.uint8))
    expected = [[60, 40], [140, 40], [100, 60], [70, 80], [130, 80]]
    assert np.allclose(face.landmarks, expected) and face.confidence is None


def test_fr403_s3_detect_calls_are_serialised_by_a_lock(landmarker_file: Path) -> None:
    active = {"now": 0, "max": 0}

    def factory(_m: bytes, _c: float, _n: int):  # type: ignore[no-untyped-def]
        def run(_image: Image) -> list[list[tuple[float, float]]]:
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
            time.sleep(0.01)
            active["now"] -= 1
            return []

        return run

    d = det.MediaPipeDetector.from_file(landmarker_file, 0.7, factory)
    img = np.zeros((10, 10, 3), dtype=np.uint8)
    threads = [threading.Thread(target=d.detect, args=(img,)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert active["max"] == 1


# ---------- remaining decode and failure paths ----------


def test_fr403_truncated_png_is_image_corrupt_and_bomb_error_is_image_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from worker.face.matcher import ImageError

    with pytest.raises(ImageError, match="IMAGE_CORRUPT"):
        decode_image(ID_A[: len(ID_A) // 2], CFG)

    def bomb(*_a: Any, **_k: Any) -> None:
        raise PILImage.DecompressionBombError("too big")

    monkeypatch.setattr(PILImage, "open", bomb)
    with pytest.raises(ImageError, match="IMAGE_SIZE"):
        decode_image(ID_A, CFG)


def test_fr403_failure_outside_the_image_steps_is_unexpected_and_logs_only_the_type(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    m = FaceMatcher(FakeDetector(), FakeEmbedder())

    def boom(*_a: Any, **_k: Any) -> float:
        raise RuntimeError("secret vector [9.87654321]")

    monkeypatch.setattr(m, "compare", boom)
    r = m.match(ID_A, ID_B)
    assert r.decision is FaceDecision.MANUAL_REVIEW and r.detail == "UNEXPECTED"
    assert "9.87654321" not in caplog.text and "RuntimeError" in caplog.text


def test_fr403_model_load_error_inside_a_flow_is_match_error_with_its_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    m = FaceMatcher(FakeDetector(), FakeEmbedder())

    def refuse(*_a: Any, **_k: Any) -> float:
        raise ModelLoadError("MODEL_HASH_MISMATCH")

    monkeypatch.setattr(m, "compare", refuse)
    assert m.match(ID_A, ID_B).detail == "MODEL_HASH_MISMATCH"
