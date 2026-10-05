"""MediaPipe Face Landmarker detector (Apache 2.0; ADR 0001 section 12.2).

Finds faces and returns the 5 alignment points taken from Face Mesh landmarks: eye centres (mean
of the two eye corners), nose tip, mouth corners. The model file `face_landmarker.task` is read
once, its name and full SHA-256 are verified, and the same bytes are given to MediaPipe as a buffer
(`FACE_LANDMARKER_MODEL_PATH`; nothing is downloaded). The mediapipe import is lazy (optional `face`
extra) and lives only in `_mediapipe_factory`, the one piece unit tests cannot run.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Final

import numpy as np

from worker.config import FaceConfig
from worker.face.modelfile import ModelLoadError, read_verified
from worker.face.types import DetectedFace, Image

LANDMARKER_PATH_ENV: Final = "FACE_LANDMARKER_MODEL_PATH"
LANDMARKER_FILE_NAME: Final = "face_landmarker.task"
# ADR 0001 section 12.2 (3,758,596 bytes, checked 2026-10-01).
LANDMARKER_BYTES: Final = 3_758_596
LANDMARKER_SHA256: Final = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
# Face Mesh indices: image-left eye corners, image-right eye corners, nose tip, mouth corners.
_LEFT_EYE: Final = (33, 133)
_RIGHT_EYE: Final = (362, 263)
_NOSE: Final = 1
_MOUTH: Final = (61, 291)
MAX_FACES: Final = 4  # enough to tell "more than one"; we never need an exact count

# One face = a list of normalized (x, y) landmarks; one call returns every face found.
RawLandmarker = Callable[[Image], list[list[tuple[float, float]]]]
LandmarkerFactory = Callable[[bytes, float, int], RawLandmarker]


def _mediapipe_factory(
    model: bytes, min_detection_confidence: float, max_faces: int
) -> RawLandmarker:  # pragma: no cover - needs mediapipe
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_buffer=model),
        num_faces=max_faces,
        min_face_detection_confidence=min_detection_confidence,
        running_mode=vision.RunningMode.IMAGE,
    )
    landmarker = vision.FaceLandmarker.create_from_options(options)

    def run(image: Image) -> list[list[tuple[float, float]]]:
        result = landmarker.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(image))
        )
        return [[(p.x, p.y) for p in face] for face in result.face_landmarks]

    return run


class MediaPipeDetector:
    """`FaceDetector` over MediaPipe. A lock serialises `detect`: the landmarker is not documented
    as thread-safe and one instance is shared by the worker's threads."""

    def __init__(
        self,
        model: bytes,
        min_detection_confidence: float = 0.7,
        factory: LandmarkerFactory = _mediapipe_factory,
    ) -> None:
        self._lock = threading.Lock()
        self._run = factory(model, min_detection_confidence, MAX_FACES)

    @classmethod
    def from_file(
        cls,
        path: Path,
        min_detection_confidence: float = 0.7,
        factory: LandmarkerFactory = _mediapipe_factory,
    ) -> MediaPipeDetector:
        """Verify file name and SHA-256, then load those same bytes. Raises ModelLoadError."""
        model = read_verified(path, LANDMARKER_FILE_NAME, LANDMARKER_SHA256, LANDMARKER_BYTES)
        try:
            return cls(model, min_detection_confidence, factory)
        except Exception:
            raise ModelLoadError("MODEL_LOAD_FAILED") from None

    @classmethod
    def from_config(
        cls, config: FaceConfig | None = None, factory: LandmarkerFactory = _mediapipe_factory
    ) -> MediaPipeDetector:
        """Build from system config: the model path comes from `FACE_LANDMARKER_MODEL_PATH` and the
        detection confidence floor from `FaceConfig.min_detection_confidence`
        (`FACE_MIN_DETECTION_CONFIDENCE`), so the configured floor reaches the landmarker."""
        cfg = config or FaceConfig.from_env()
        raw = os.environ.get(LANDMARKER_PATH_ENV)
        if not raw:
            raise ModelLoadError("MODEL_PATH_NOT_SET")
        return cls.from_file(Path(raw), cfg.min_detection_confidence, factory)

    def detect(self, image: Image) -> list[DetectedFace]:
        with self._lock:
            raw = self._run(image)
        h, w = image.shape[:2]
        faces: list[DetectedFace] = []
        for lm in raw:
            pts = np.array([[x * w, y * h] for x, y in lm], dtype=np.float32)
            five = np.stack(
                [
                    pts[list(_LEFT_EYE)].mean(axis=0),
                    pts[list(_RIGHT_EYE)].mean(axis=0),
                    pts[_NOSE],
                    pts[_MOUTH[0]],
                    pts[_MOUTH[1]],
                ]
            ).astype(np.float32)
            # The landmarker reports no per-face score; its confidence floor is in its options.
            faces.append(DetectedFace(five, None))
        return faces
