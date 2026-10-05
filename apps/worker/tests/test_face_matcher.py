from __future__ import annotations

import builtins
import copy
import logging
import pickle
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from face_helpers import (
    LANDMARKS,
    FakeDetector,
    FakeEmbedder,
    FixedEmbedder,
    synthetic_png,
    to_array,
)
from worker.config import FaceConfig, IntegrityConfig
from worker.face import FaceDecision, FaceMatcher, ReviewReason
from worker.face.embedding import MODEL_ID, ModelLoadError
from worker.face.matcher import SelfieCache, decode_image, review_for_model_error
from worker.face.types import AlignedFace, DetectedFace, Embedding

ID_A, ID_B = synthetic_png(0), synthetic_png(1)


def matcher(
    detector: FakeDetector | None = None,
    embedder: Any = None,
    **cfg: Any,
) -> FaceMatcher:
    return FaceMatcher(
        detector or FakeDetector(), embedder or FakeEmbedder(), FaceConfig.model_validate(cfg)
    )


# ---------- the decision space: no reject ----------


def test_fr403_d05_decision_enum_has_no_reject_or_fail_member() -> None:
    assert {d.value for d in FaceDecision} == {"MATCH", "MANUAL_REVIEW"}
    assert {r.value for r in ReviewReason} == {
        "BELOW_THRESHOLD",
        "NO_FACE",
        "MULTIPLE_FACES",
        "LIVENESS_NOT_CONFIRMED",
        "MATCH_ERROR",
    }  # mirrors identity_review_reason in ADR 0004


def _explode(_image: Any) -> list[DetectedFace]:
    raise ZeroDivisionError


def failure_modes() -> list[tuple[str, FaceMatcher, bytes, bytes]]:
    good = (ID_A, ID_B)
    return [
        ("no face", matcher(FakeDetector([])), *good),
        ("two faces", matcher(FakeDetector([DetectedFace(LANDMARKS, 0.9)] * 2)), *good),
        ("low confidence", matcher(FakeDetector([DetectedFace(LANDMARKS, 0.1)])), *good),
        ("corrupt", matcher(), b"not an image", ID_B),
        ("empty", matcher(), b"", ID_B),
        ("oversized", matcher(max_image_bytes=10), ID_A, ID_B),
        ("too many pixels", matcher(max_image_pixels=100), ID_A, ID_B),
        ("model error", matcher(embedder=FakeEmbedder(fail=RuntimeError("boom"))), *good),
        ("detector error", matcher(FakeDetector(_explode)), *good),
        ("below threshold", matcher(), ID_A, ID_B),
    ]


@pytest.mark.parametrize("idx", range(10))
def test_fr403_tc033_every_failure_mode_is_manual_review_with_a_reason(idx: int) -> None:
    name, m, a, b = failure_modes()[idx]
    r = m.match(a, b)
    assert r.decision is FaceDecision.MANUAL_REVIEW, name
    assert r.reason is not None, name
    assert r.model_id and r.threshold == m.config.match_threshold


def test_fr403_hash_mismatch_maps_to_manual_review_match_error() -> None:
    r = review_for_model_error(ModelLoadError("MODEL_HASH_MISMATCH"))
    assert r.decision is FaceDecision.MANUAL_REVIEW
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "MODEL_HASH_MISMATCH"
    assert r.model_id == MODEL_ID and r.score is None


def test_fr403_reason_codes_for_each_case() -> None:
    reasons = {n: (m.match(a, b).reason, m.match(a, b).detail) for n, m, a, b in failure_modes()}
    assert reasons["no face"] == (ReviewReason.NO_FACE, "NO_FACE")
    assert reasons["two faces"][0] is ReviewReason.MULTIPLE_FACES
    assert reasons["low confidence"] == (ReviewReason.NO_FACE, "LOW_DETECTION_CONFIDENCE")
    assert reasons["corrupt"] == (ReviewReason.MATCH_ERROR, "IMAGE_CORRUPT")
    assert reasons["oversized"] == (ReviewReason.MATCH_ERROR, "IMAGE_SIZE")
    assert reasons["too many pixels"] == (ReviewReason.MATCH_ERROR, "IMAGE_SIZE")
    assert reasons["model error"] == (ReviewReason.MATCH_ERROR, "UNEXPECTED")
    assert reasons["below threshold"][0] is ReviewReason.BELOW_THRESHOLD


def test_fr403_liveness_not_confirmed_goes_to_manual_review_without_running_the_model() -> None:
    emb = FakeEmbedder()
    r = matcher(embedder=emb).match(ID_A, ID_A, liveness_confirmed=False)
    assert r.decision is FaceDecision.MANUAL_REVIEW
    assert r.reason is ReviewReason.LIVENESS_NOT_CONFIRMED and emb.calls == 0


def test_fr403_tc034_liveness_is_client_reported_and_only_leads_to_review() -> None:
    for confirmed in (True, False):
        r = matcher().match(ID_A, ID_A, liveness_confirmed=confirmed)
        assert r.decision in set(FaceDecision)


# ---------- matching and threshold ----------


def test_fr403_same_identity_matches_different_identity_goes_to_review() -> None:
    m = matcher()
    same = m.match(ID_A, synthetic_png(0))
    assert same.decision is FaceDecision.MATCH and same.score == pytest.approx(1.0)
    assert same.reason is None and same.model_id == "fake:1"
    other = m.match(ID_A, ID_B)
    assert other.decision is FaceDecision.MANUAL_REVIEW
    assert other.reason is ReviewReason.BELOW_THRESHOLD and other.score is not None


def test_fr403_threshold_boundary_at_or_above_matches_just_below_reviews() -> None:
    vecs = [[1.0, 0.0, 0.0], [0.6, 0.8, 0.0]]
    probe = matcher(embedder=FixedEmbedder(vecs)).match(ID_A, ID_B)
    score = probe.score
    assert score is not None
    at = matcher(embedder=FixedEmbedder(vecs), matchThreshold=score).match(ID_A, ID_B)
    assert at.decision is FaceDecision.MATCH
    above = float(np.nextafter(score, 1.0))
    just = matcher(embedder=FixedEmbedder(vecs), matchThreshold=above).match(ID_A, ID_B)
    assert just.decision is FaceDecision.MANUAL_REVIEW
    assert just.reason is ReviewReason.BELOW_THRESHOLD


class _BadEmbedder(FixedEmbedder):
    def __init__(self, bad: list[float]) -> None:
        super().__init__([])
        self._bad = bad

    def embed(self, aligned: AlignedFace) -> Embedding:
        return Embedding(np.asarray(self._bad, dtype=np.float32))


def test_fr403_zero_norm_or_nan_embedding_is_match_error_not_a_crash() -> None:
    for bad in ([0.0, 0.0], [float("nan"), 1.0]):
        r = matcher(embedder=_BadEmbedder(bad)).match(ID_A, ID_B)
        assert r.decision is FaceDecision.MANUAL_REVIEW and r.reason is ReviewReason.MATCH_ERROR
        assert r.detail in {"ZERO_NORM", "NON_FINITE"}


def test_fr403_embedding_dimension_mismatch_is_match_error() -> None:
    r = matcher(embedder=FixedEmbedder([[1.0, 2.0], [1.0, 2.0, 3.0]])).match(ID_A, ID_B)
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "DIM_MISMATCH"


def test_fr403_non_finite_score_is_match_error() -> None:
    m = matcher()
    assert m._decide(float("nan")).reason is ReviewReason.MATCH_ERROR


def test_fr403_detector_confidence_none_is_accepted_and_floor_applies_when_reported() -> None:
    ok = matcher(FakeDetector([DetectedFace(LANDMARKS, None)]))
    assert ok.match(ID_A, ID_A).decision is FaceDecision.MATCH
    low = matcher(FakeDetector([DetectedFace(LANDMARKS, 0.69)]), minDetectionConfidence=0.7)
    assert low.match(ID_A, ID_A).reason is ReviewReason.NO_FACE
    edge = matcher(FakeDetector([DetectedFace(LANDMARKS, 0.7)]), minDetectionConfidence=0.7)
    assert edge.match(ID_A, ID_A).decision is FaceDecision.MATCH


def test_fr403_one_good_face_among_low_confidence_ones_is_used() -> None:
    faces = [DetectedFace(LANDMARKS, 0.99), DetectedFace(LANDMARKS, 0.1)]
    assert matcher(FakeDetector(faces)).match(ID_A, ID_A).decision is FaceDecision.MATCH


# ---------- D-05 interface ----------


def test_fr403_interface_detect_and_align_embed_compare_model_id() -> None:
    m = matcher()
    faces = m.detect_and_align(to_array(ID_A))
    assert len(faces) == 1 and faces[0].pixels.shape == (112, 112, 3)
    a, b = m.embed(faces[0]), m.embed(m.detect_and_align(to_array(ID_B))[0])
    assert m.compare(a, a) == pytest.approx(1.0) and m.compare(a, b) < 0.75
    assert m.model_id == "fake:1"
    low = matcher(FakeDetector([DetectedFace(LANDMARKS, 0.1)]))
    assert low.detect_and_align(to_array(ID_A)) == []


# ---------- images ----------


def test_fr403_decode_accepts_png_and_jpeg_and_rejects_other_formats(tmp_path: Path) -> None:
    import io

    from PIL import Image as PILImage

    cfg = FaceConfig()
    assert decode_image(ID_A, cfg).shape == (224, 224, 3)
    buf = io.BytesIO()
    PILImage.new("RGB", (30, 20), (10, 20, 30)).save(buf, format="JPEG")
    assert decode_image(buf.getvalue(), cfg).shape == (20, 30, 3)
    gif = io.BytesIO()
    PILImage.new("RGB", (8, 8)).save(gif, format="GIF")
    r = matcher().match(gif.getvalue(), ID_B)
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "IMAGE_FORMAT"
    rgba = io.BytesIO()
    PILImage.new("RGBA", (8, 8), (1, 2, 3, 4)).save(rgba, format="PNG")
    assert decode_image(rgba.getvalue(), cfg).shape == (8, 8, 3)


# ---------- selfie cache (ADR 0004 section 2) ----------


def test_fr606_selfie_cache_keeps_only_the_selfie_and_is_cleared_at_session_end() -> None:
    m = matcher()
    m.match(ID_A, ID_B, session_id="s1")
    assert len(m.selfie_cache) == 1  # the ID embedding is never kept
    cached = m.selfie_cache.get("s1")
    assert cached is not None
    expected = m.embed(m.detect_and_align(to_array(ID_B))[0])
    assert np.array_equal(cached.vector, expected.vector)
    m.end_session("s1")
    assert len(m.selfie_cache) == 0 and m.selfie_cache.get("s1") is None


def test_fr606_match_without_session_id_caches_nothing() -> None:
    m = matcher()
    m.match(ID_A, ID_B)
    assert len(m.selfie_cache) == 0


def test_fr606_cache_is_a_bounded_lru() -> None:
    cache = SelfieCache(2)
    e = Embedding(np.ones(3, dtype=np.float32))
    cache.put("a", e)
    cache.put("b", e)
    assert cache.get("a") is e  # touch a
    cache.put("c", e)  # evicts b, the least recently used
    assert cache.get("b") is None and cache.get("a") is e and len(cache) == 2
    cache.clear()
    assert len(cache) == 0
    with pytest.raises(ValueError):
        SelfieCache(0)


def test_fr606_matcher_cache_size_comes_from_config() -> None:
    m = matcher(selfieCacheMaxSessions=2)
    for i in range(5):
        m.match(ID_A, ID_B, session_id=f"s{i}")
    assert len(m.selfie_cache) == 2


def test_fr606_recheck_matches_same_person_reviews_other_and_miss_asks_for_recompute() -> None:
    m = matcher()
    assert m.recheck("s1", ID_B).detail == "CACHE_MISS"
    m.match(ID_A, ID_B, session_id="s1")
    assert m.recheck("s1", synthetic_png(1)).decision is FaceDecision.MATCH
    other = m.recheck("s1", ID_A)
    assert (
        other.decision is FaceDecision.MANUAL_REVIEW
        and other.reason is ReviewReason.BELOW_THRESHOLD
    )
    assert m.recheck("s1", b"junk").reason is ReviewReason.MATCH_ERROR
    broken = FaceMatcher(FakeDetector(_explode), FakeEmbedder())
    broken.selfie_cache.put("s", Embedding(np.ones(3, dtype=np.float32)))
    assert broken.recheck("s", ID_A).detail == "UNEXPECTED"


# ---------- privacy ----------


def test_adr0004_embeddings_never_appear_in_repr_str_or_results() -> None:
    m = matcher()
    e = m.embed(m.detect_and_align(to_array(ID_A))[0])
    digits = f"{float(e.vector[0]):.4f}"[:6]
    texts = [repr(e), str(e), repr(m.selfie_cache), repr(AlignedFace(to_array(ID_A)[:112, :112]))]
    m.match(ID_A, ID_B, session_id="s1")
    texts += [repr(m.selfie_cache), repr(m.match(ID_A, ID_B)), repr(m.selfie_cache.get("s1"))]
    for t in texts:
        assert digits not in t and "array(" not in t
    assert repr(e) == "Embedding(dim=512, redacted)"


def test_adr0004_embeddings_cannot_be_pickled_or_copied() -> None:
    e = Embedding(np.ones(4, dtype=np.float32))
    for fn in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            fn(e)


def test_adr0004_error_messages_and_logs_carry_no_vector_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "13.37133713"  # noqa: S105 (fake vector text)

    class Leaky(FakeEmbedder):
        def embed(self, aligned: AlignedFace) -> Embedding:
            raise RuntimeError(f"vector was [{secret}]")

    with caplog.at_level(logging.DEBUG):
        r = matcher(embedder=Leaky()).match(ID_A, ID_B, session_id="s1")
        m = matcher()
        m.match(ID_A, ID_B, session_id="s2")
    assert secret not in repr(r) and r.detail == "UNEXPECTED"
    assert secret not in caplog.text
    assert "s1" not in caplog.text  # session ids are not logged either


def test_adr0004_nothing_is_written_to_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    real_open = builtins.open
    writes: list[str] = []

    def guarded(file: Any, mode: str = "r", *a: Any, **k: Any) -> Any:
        if any(c in mode for c in "wax+"):
            writes.append(str(file))
        return real_open(file, mode, *a, **k)

    monkeypatch.setattr(builtins, "open", guarded)
    m = matcher()
    m.match(ID_A, ID_B, session_id="s1")
    m.recheck("s1", ID_A)
    m.end_session("s1")
    assert writes == [] and list(tmp_path.iterdir()) == []


def test_f1_no_onnx_model_files_are_tracked_or_present_in_the_worker() -> None:
    root = Path(__file__).resolve().parents[1]
    assert [p for p in root.rglob("*.onnx") if ".venv" not in p.parts] == []
    try:
        tracked = subprocess.run(  # noqa: S603
            ["git", "ls-files", "*.onnx", "*.task", "*.tflite"],  # noqa: S607
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("git not available")
    assert tracked == []


# ---------- config ----------


def test_fr403_config_default_is_a_placeholder_that_errs_toward_review() -> None:
    cfg = FaceConfig()
    assert cfg.match_threshold >= 0.7  # high on purpose: doubt goes to a human (INT-01 will tune)
    assert FaceConfig.__doc__ is not None and "PLACEHOLDER" in FaceConfig.__doc__


def test_fr403_config_validation_and_org_override() -> None:
    assert (
        IntegrityConfig.model_validate({"face": {"matchThreshold": 0.9}}).face.match_threshold
        == 0.9
    )
    assert (
        IntegrityConfig.model_validate({"face": {"match_threshold": 0.8}}).face.match_threshold
        == 0.8
    )
    for bad in (
        {"matchThreshold": 0.1},
        {"matchThreshold": 1.5},
        {"maxImageBytes": 0},
        {"bogus": 1},
        {"minDetectionConfidence": 2},
    ):
        with pytest.raises(ValidationError):
            FaceConfig.model_validate(bad)


def test_fr403_image_just_over_the_pixel_limit_is_rejected_as_size() -> None:
    import io

    from PIL import Image as PILImage

    buf = io.BytesIO()
    PILImage.new("RGB", (12, 12)).save(buf, format="PNG")  # 144 px, limit 100 (under Pillow's 2x)
    r = matcher(maxImagePixels=100).match(buf.getvalue(), ID_B)
    assert r.reason is ReviewReason.MATCH_ERROR and r.detail == "IMAGE_SIZE"
