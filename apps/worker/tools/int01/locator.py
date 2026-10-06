"""ID-portrait locator for the crop-and-delete intake (volunteer form section 2, C-11).

`DetectorLocator` adapts the worker's `FaceDetector` (MediaPipe in production, a fake in tests) to
`intake.FaceLocator`: it applies the same rules the matcher applies to an ID photo (low-confidence
detections are dropped; a face much smaller than the largest is a ghost portrait and is ignored;
two comparable faces raise MULTIPLE_FACES) and turns the five landmarks into a pixel box.

The box proportions below are a heuristic from eye distance and eye-to-mouth distance. They are NOT
verified against the real landmarker or real ID photos (FU-INB-05, P-13): check every crop by eye.
Intake adds only a thin margin (`LOCATOR_MARGIN`). A face box over 60% of the image, or landmarks
whose proportions are not a plausible upright face, give no box (NO_FACE): refusing is safer than
keeping the whole card.
"""

from __future__ import annotations

import numpy as np

from tools.int01.intake import Box, Image, IntakeError
from worker.config import FaceConfig
from worker.face.matcher import face_size
from worker.face.types import DetectedFace, FaceDetector

# The box below is already the whole face, so the crop adds only a thin margin (intake's default
# 0.35 is for a tight detector box and would double-count).
LOCATOR_MARGIN = 0.05
# A frontal face has an eye-to-mouth distance of about 1.0 to 1.2 eye distances; 0.6 to 1.6 is
# deliberate slack for head pose. Outside it the landmarks are not a plausible upright face.
PLAUSIBLE_DROP_RATIO = (0.6, 1.6)
# A portrait on an ID card is a small part of the image. A box over this share of the image is
# not a portrait: refuse it rather than keep the whole card.
MAX_AREA_SHARE = 0.6

# Face extent from the landmarks (left eye, right eye, nose, left mouth, right mouth):
WIDTH_PER_EYE_DISTANCE = 2.2  # face width, centred on the landmarks
TOP_PER_MOUTH_DROP = 1.2  # above the eye line, in eye-to-mouth distances (forehead and hair)
BOTTOM_PER_MOUTH_DROP = 0.9  # below the mouth line (chin)


def landmarks_to_box(face: DetectedFace, image_shape: tuple[int, ...]) -> Box | None:
    """Pixel box around the face, clamped to the image; None if the landmarks are degenerate."""
    pts = np.asarray(face.landmarks, dtype=np.float64)
    if pts.shape != (5, 2) or not np.all(np.isfinite(pts)):
        return None
    left_eye, right_eye, _nose, left_mouth, right_mouth = pts
    eye_distance = float(np.linalg.norm(right_eye - left_eye))
    eye_y = float((left_eye[1] + right_eye[1]) / 2)
    mouth_y = float((left_mouth[1] + right_mouth[1]) / 2)
    drop = mouth_y - eye_y
    if eye_distance < 4.0 or drop < 4.0:  # not a plausible upright face
        return None
    if not PLAUSIBLE_DROP_RATIO[0] <= drop / eye_distance <= PLAUSIBLE_DROP_RATIO[1]:
        return None
    cx = float(pts[:, 0].mean())
    half = WIDTH_PER_EYE_DISTANCE * eye_distance / 2
    height, width = image_shape[0], image_shape[1]
    x0, x1 = max(0, int(cx - half)), min(width, int(np.ceil(cx + half)))
    y0 = max(0, int(eye_y - TOP_PER_MOUTH_DROP * drop))
    y1 = min(height, int(np.ceil(mouth_y + BOTTOM_PER_MOUTH_DROP * drop)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    if (x1 - x0) * (y1 - y0) > MAX_AREA_SHARE * width * height:
        return None
    return Box(x0, y0, x1, y1)


class DetectorLocator:
    """`intake.FaceLocator` over a worker `FaceDetector`. Nothing is kept between calls."""

    def __init__(self, detector: FaceDetector, config: FaceConfig | None = None) -> None:
        self._detector = detector
        self._config = config if config is not None else FaceConfig.from_env()

    def locate(self, image: Image) -> list[Box]:
        """One box per usable face. A detector failure of any kind is the fixed code
        DETECTOR_FAILED (no exception text, no path), so intake still deletes the original and
        reports it. Two comparable faces raise MULTIPLE_FACES here, as the matcher does, even if
        one of them has landmarks too odd to box."""
        try:
            floor = self._config.min_detection_confidence
            # A detector that reports no confidence (MediaPipe here) is filtered by the floor
            # inside the landmarker itself.
            faces = [
                f
                for f in self._detector.detect(image)
                if f.confidence is None or f.confidence >= floor
            ]
            if len(faces) > 1:  # the matcher's ID rule: smaller faces are a ghost portrait
                faces.sort(key=face_size, reverse=True)
                keep = self._config.id_secondary_face_ratio * face_size(faces[0])
                faces = [f for f in faces if face_size(f) >= keep]
            if len(faces) > 1:
                raise IntakeError("MULTIPLE_FACES")
            boxes = (landmarks_to_box(f, image.shape) for f in faces)
            return [b for b in boxes if b is not None]
        except IntakeError:
            raise
        except Exception:  # noqa: BLE001 - MemoryError, MediaPipe errors, odd landmark shapes
            raise IntakeError("DETECTOR_FAILED") from None
