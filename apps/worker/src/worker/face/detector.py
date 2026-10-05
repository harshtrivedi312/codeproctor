"""MediaPipe Face Landmarker detector (Apache 2.0; ADR 0001 section 12.2).

Finds faces and returns the 5 alignment points taken from Face Mesh landmarks: eye centres (mean
of the two eye corners), nose tip, mouth corners. The model file `face_landmarker.task` is loaded
from a local path (env `FACE_LANDMARKER_MODEL_PATH`); nothing is downloaded. The import of
mediapipe is lazy (optional `face` extra). This file needs the real library, so it is excluded from
unit coverage and only an opt-in test would exercise it.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

import numpy as np

from worker.face.types import DetectedFace, Image

LANDMARKER_PATH_ENV: Final = "FACE_LANDMARKER_MODEL_PATH"
# Face Mesh indices: image-left eye corners, image-right eye corners, nose tip, mouth corners.
_LEFT_EYE: Final = (33, 133)
_RIGHT_EYE: Final = (362, 263)
_NOSE: Final = 1
_MOUTH: Final = (61, 291)
MAX_FACES: Final = 4  # enough to tell "more than one"; we never need an exact count


class MediaPipeDetector:  # pragma: no cover - needs mediapipe and the model file
    def __init__(self, model_path: Path, min_detection_confidence: float = 0.5) -> None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        options = vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
            num_faces=MAX_FACES,
            min_face_detection_confidence=min_detection_confidence,
            running_mode=vision.RunningMode.IMAGE,
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(options)

    @classmethod
    def from_env(cls, min_detection_confidence: float = 0.5) -> MediaPipeDetector:
        raw = os.environ.get(LANDMARKER_PATH_ENV)
        if not raw:
            raise RuntimeError("MODEL_PATH_NOT_SET")
        return cls(Path(raw), min_detection_confidence)

    def detect(self, image: Image) -> list[DetectedFace]:
        import mediapipe as mp

        result = self._landmarker.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(image))
        )
        h, w = image.shape[:2]
        faces: list[DetectedFace] = []
        for lm in result.face_landmarks:
            pts = np.array([[p.x * w, p.y * h] for p in lm], dtype=np.float32)
            five = np.stack(
                [
                    pts[list(_LEFT_EYE)].mean(axis=0),
                    pts[list(_RIGHT_EYE)].mean(axis=0),
                    pts[_NOSE],
                    pts[_MOUTH[0]],
                    pts[_MOUTH[1]],
                ]
            ).astype(np.float32)
            # The landmarker reports no per-face score; the confidence floor is set in its options.
            faces.append(DetectedFace(five, None))
        return faces
