"""Production wiring: verified AuraFace + MediaPipe, both configured from system config (FR-403)."""

from __future__ import annotations

from worker.config import FaceConfig
from worker.face.detector import LandmarkerFactory, MediaPipeDetector, _mediapipe_factory
from worker.face.embedding import AuraFaceEmbedder, SessionFactory, _ort_session
from worker.face.matcher import FaceMatcher


def build_face_matcher(
    config: FaceConfig | None = None,
    *,
    session_factory: SessionFactory = _ort_session,
    landmarker_factory: LandmarkerFactory = _mediapipe_factory,
) -> FaceMatcher:
    """Build the matcher from `FACE_*` env (or the given config). The configured detection floor is
    passed to the landmarker. Raises ModelLoadError if either model file is missing or fails its
    pin; catch it and use `review_for_model_error` so the candidate goes to manual review."""
    cfg = config if config is not None else FaceConfig.from_env()
    detector = MediaPipeDetector.from_config(cfg, landmarker_factory)
    embedder = AuraFaceEmbedder.from_env(session_factory)
    return FaceMatcher(detector, embedder, cfg)
