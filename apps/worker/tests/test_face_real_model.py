"""Opt-in: the face routes with the REAL AuraFace model (FR-403, FR-606, TC-033; C-22).

Runs only when AURAFACE_MODEL_PATH points at glintr100.onnx (kept in ~/.cache/codeproctor/models,
never in git). Detection is faked: `face_landmarker.task` is not downloaded (C-22 approves
glintr100.onnx only), so these tests prove the embedding half end to end through the signed
routes. Synthetic cartoon images only: scores between different cartoons are not meaningful, so
only identical images and the never-reject rule are asserted.

    AURAFACE_MODEL_PATH=$HOME/.cache/codeproctor/models/glintr100.onnx pytest tests/test_face_real_model.py
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from face_helpers import FakeDetector
from test_face_routes import ID_A, ID_B, World, match_req, recheck_req
from worker.config import FaceConfig
from worker.face.embedding import AURAFACE_SHA256, MODEL_ID, AuraFaceEmbedder
from worker.face.matcher import FaceMatcher

MODEL = os.environ.get("AURAFACE_MODEL_PATH", "")

pytestmark = pytest.mark.skipif(
    not MODEL or not Path(MODEL).is_file(), reason="AURAFACE_MODEL_PATH is not set (opt-in test)"
)


def real_world() -> World:
    matcher = FaceMatcher(
        FakeDetector(), AuraFaceEmbedder.from_env(), FaceConfig.model_validate({})
    )
    return World(matcher)


def test_fr403_tc033_real_model_identical_images_match_through_the_signed_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = real_world()
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_A), monkeypatch)
    j = r.json()
    assert r.status_code == 200 and j["decision"] == "MATCH" and j["score"] > 0.99
    assert j["modelId"] == MODEL_ID and AURAFACE_SHA256[:8] in j["modelId"]
    assert len(w.matcher.selfie_cache) == 0  # nothing kept (cacheSelfie false)


def test_fr403_tc033_real_model_never_rejects_whatever_the_score(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = real_world()
    r = w.post("/v1/face/match", match_req(w, ID_A, ID_B), monkeypatch)
    assert r.json()["decision"] in ("MATCH", "MANUAL_REVIEW")
    assert r.json()["score"] is not None and -1.0 <= r.json()["score"] <= 1.0


def test_fr606_real_model_recheck_computes_both_embeddings_and_keeps_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = real_world()
    r = w.post("/v1/face/recheck", recheck_req(w, ID_A, ID_A), monkeypatch)
    assert r.json()["outcome"] == "MATCH" and r.json()["cache"] == "OFF"
    assert w.matcher.selfie_cache.get("sess-SENTINEL-1") is None
