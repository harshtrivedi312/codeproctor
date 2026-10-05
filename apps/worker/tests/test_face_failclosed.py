"""Fail-closed behaviour of the biometric gate: liveness, non-finite scores, config, model size."""

from __future__ import annotations

import hashlib
import inspect
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from face_helpers import FakeDetector, FakeEmbedder, FixedEmbedder, synthetic_png
from test_face_embedding import FakeSession
from worker.config import FaceConfig
from worker.face import FaceDecision, FaceMatcher, ReviewReason
from worker.face import detector as det
from worker.face import embedding as emb
from worker.face.embedding import cosine
from worker.face.factory import build_face_matcher
from worker.face.matcher import review_for_model_error
from worker.face.modelfile import ModelLoadError, read_verified
from worker.face.types import AlignedFace, Embedding, EmbeddingError

ID_A, ID_B = synthetic_png(0), synthetic_png(1)


# ---------- BLOCKER: liveness is required and fails closed ----------


def test_fr403_tc034_liveness_confirmed_is_a_required_keyword_with_no_default() -> None:
    p = inspect.signature(FaceMatcher.match).parameters["liveness_confirmed"]
    assert p.kind is inspect.Parameter.KEYWORD_ONLY and p.default is inspect.Parameter.empty
    m = FaceMatcher(FakeDetector(), FakeEmbedder(), FaceConfig())
    with pytest.raises(TypeError):
        m.match(ID_A, ID_A)  # type: ignore[call-arg]


@pytest.mark.parametrize("reported", [False, None, 0, "yes", 1])
def test_fr403_tc034_anything_but_true_is_manual_review_and_never_a_match(reported: Any) -> None:
    emb_ = FakeEmbedder()
    m = FaceMatcher(FakeDetector(), emb_, FaceConfig())
    r = m.match(ID_A, ID_A, liveness_confirmed=reported)
    assert r.decision is FaceDecision.MANUAL_REVIEW
    assert r.reason is ReviewReason.LIVENESS_NOT_CONFIRMED and emb_.calls == 0


# ---------- SF1: NaN must never become a perfect score ----------


class _NanEmbedding(Embedding):
    """Embedding whose vector was corrupted after validation (simulates memory/model faults)."""

    def __init__(self) -> None:
        super().__init__(np.ones(4, dtype=np.float32))
        self._v = np.array([np.nan, 1.0, 1.0, 1.0], dtype=np.float32)


def test_fr403_sf1_cosine_raises_on_non_finite_instead_of_clamping_to_one() -> None:
    ok = Embedding(np.ones(4, dtype=np.float32))
    with pytest.raises(EmbeddingError, match="NON_FINITE_SCORE"):
        cosine(_NanEmbedding(), ok)
    zero = Embedding(np.ones(4, dtype=np.float32))
    zero._v = np.zeros(4, dtype=np.float32)  # 0/0 -> NaN
    with pytest.raises(EmbeddingError, match="NON_FINITE_SCORE"):
        cosine(zero, ok)


def test_fr403_tc033_sf1_a_nan_score_through_match_is_manual_review_not_a_match() -> None:
    class Corrupt(FixedEmbedder):
        def embed(self, aligned: AlignedFace) -> Embedding:
            return _NanEmbedding()

    r = FaceMatcher(FakeDetector(), Corrupt([]), FaceConfig()).match(
        ID_A, ID_B, liveness_confirmed=True
    )
    assert r.decision is FaceDecision.MANUAL_REVIEW
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "NON_FINITE_SCORE"
    assert r.score is None


# ---------- SF2: prime_selfie ----------


def test_fr606_sf2_prime_selfie_recomputes_only_the_selfie_after_a_cache_miss() -> None:
    e = FakeEmbedder()
    m = FaceMatcher(FakeDetector(), e, FaceConfig())
    assert m.recheck("s1", ID_B).detail == "CACHE_MISS"
    before = e.calls
    assert m.prime_selfie("s1", ID_B) is None
    assert e.calls == before + 1  # one inference: the selfie; no ID image is embedded
    assert m.recheck("s1", synthetic_png(1)).decision is FaceDecision.MATCH
    assert m.recheck("s1", ID_A).reason is ReviewReason.BELOW_THRESHOLD


def test_fr606_sf2_prime_selfie_is_strict_single_face_and_reports_failures() -> None:
    no_face = FaceMatcher(FakeDetector([]), FakeEmbedder(), FaceConfig())
    r = no_face.prime_selfie("s", ID_B)
    assert r is not None and r.detail == "SELFIE_NO_FACE"
    assert len(no_face.selfie_cache) == 0
    bad = FaceMatcher(FakeDetector(), FakeEmbedder(), FaceConfig()).prime_selfie("s", b"junk")
    assert bad is not None and bad.reason is ReviewReason.MATCH_ERROR
    boom = FaceMatcher(FakeDetector(), FakeEmbedder(fail=RuntimeError("x")), FaceConfig())
    r2 = boom.prime_selfie("s", ID_B)
    assert r2 is not None and r2.decision is FaceDecision.MANUAL_REVIEW


# ---------- SF4: no silent default config ----------


def test_fr403_sf4_default_config_comes_from_face_env_not_built_in_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACE_MATCH_THRESHOLD", "0.9")
    m = FaceMatcher(FakeDetector(), FakeEmbedder())
    assert m.config.match_threshold == 0.9
    r = review_for_model_error(ModelLoadError("MODEL_HASH_MISMATCH"))
    assert r.threshold == 0.9
    monkeypatch.setenv("FACE_MATCH_THRESHOLD", "0.01")  # invalid: fails loudly, not silently
    with pytest.raises(ValidationError):
        FaceMatcher(FakeDetector(), FakeEmbedder())


# ---------- SF3: the configured detection floor reaches the production detector ----------


def test_fr403_sf3_build_face_matcher_wires_the_configured_detection_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = tmp_path / "glintr100.onnx"
    model.write_bytes(b"synthetic auraface placeholder")
    lm = tmp_path / "face_landmarker.task"
    lm.write_bytes(b"synthetic landmarker placeholder")
    monkeypatch.setattr(emb, "AURAFACE_SHA256", hashlib.sha256(model.read_bytes()).hexdigest())
    monkeypatch.setattr(det, "LANDMARKER_SHA256", hashlib.sha256(lm.read_bytes()).hexdigest())
    monkeypatch.setenv("AURAFACE_MODEL_PATH", str(model))
    monkeypatch.setenv(det.LANDMARKER_PATH_ENV, str(lm))
    monkeypatch.setenv("FACE_MIN_DETECTION_CONFIDENCE", "0.9")
    seen: dict[str, Any] = {}

    def landmarker(model_bytes: bytes, min_conf: float, max_faces: int) -> Any:
        seen.update(min_conf=min_conf, bytes=model_bytes)
        return lambda _image: []

    matcher = build_face_matcher(
        session_factory=lambda _b: FakeSession(), landmarker_factory=landmarker
    )
    assert seen["min_conf"] == 0.9 and seen["bytes"] == lm.read_bytes()
    assert matcher.config.min_detection_confidence == 0.9 and matcher.model_id == emb.MODEL_ID


def test_fr403_sf3_build_face_matcher_refuses_an_unverified_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lm = tmp_path / "face_landmarker.task"
    lm.write_bytes(b"tampered")
    monkeypatch.setenv(det.LANDMARKER_PATH_ENV, str(lm))
    with pytest.raises(ModelLoadError, match="MODEL_HASH_MISMATCH"):
        build_face_matcher(FaceConfig(), landmarker_factory=lambda *_a: lambda _i: [])


# ---------- nits: image pixel bound and model size cap ----------


def test_fr403_max_image_pixels_cannot_exceed_pillows_guard_value() -> None:
    assert FaceConfig(max_image_pixels=25_000_000).max_image_pixels == 25_000_000
    with pytest.raises(ValidationError):
        FaceConfig(max_image_pixels=25_000_001)


def test_fr403_oversized_model_file_is_refused_before_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = tmp_path / "glintr100.onnx"
    p.write_bytes(b"x" * 33)
    reads = {"n": 0}
    real = Path.read_bytes

    def counting(self: Path) -> bytes:
        reads["n"] += 1
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", counting)
    with pytest.raises(ModelLoadError, match="MODEL_TOO_LARGE"):
        read_verified(p, "glintr100.onnx", "0" * 64, max_bytes=32)
    assert reads["n"] == 0


def test_fr403_adr_byte_counts_are_pinned() -> None:
    assert emb.AURAFACE_BYTES == 260_694_151 and det.LANDMARKER_BYTES == 3_758_596
