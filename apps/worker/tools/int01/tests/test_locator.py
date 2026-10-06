# ruff: noqa: S101, E501
"""ID-portrait locator and crop CLI tests (C-11, FR-403). Fake detector, synthetic images only."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image as PILImage

from face_helpers import LANDMARKS, FakeDetector, synthetic_png

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.int01 import crop_id, intake, locator  # noqa: E402

from worker.config import FaceConfig  # noqa: E402
from worker.face.types import DetectedFace  # noqa: E402

CFG = FaceConfig.model_validate({})
SHAPE = (224, 224, 3)


def face(landmarks: np.ndarray | None = None, confidence: float | None = 0.99) -> DetectedFace:
    return DetectedFace(LANDMARKS.copy() if landmarks is None else landmarks, confidence)


def scaled(factor: float, dx: float = 0.0) -> np.ndarray:
    pts = LANDMARKS.astype(np.float64)
    centre = pts.mean(axis=0)
    out = (pts - centre) * factor + centre + np.array([dx, 0.0])
    return np.asarray(out, dtype=np.float32)


def test_c11_box_contains_the_landmarks_and_stays_inside_the_image() -> None:
    box = locator.landmarks_to_box(face(), SHAPE)
    assert box is not None
    for x, y in LANDMARKS:
        assert box.x0 <= x <= box.x1 and box.y0 <= y <= box.y1
    assert 0 <= box.x0 < box.x1 <= 224 and 0 <= box.y0 < box.y1 <= 224
    # near an edge the box is clamped, never negative or past the image
    edge = locator.landmarks_to_box(face(scaled(1.0, dx=-70)), SHAPE)
    assert edge is not None and edge.x0 == 0 and edge.x1 <= 224


@pytest.mark.parametrize(
    "bad",
    [
        np.zeros((5, 2), dtype=np.float32),  # all landmarks on one point
        np.full((5, 2), np.nan, dtype=np.float32),
        np.array(
            [[10, 10], [200, 10], [100, 5], [60, 4], [160, 4]], dtype=np.float32
        ),  # mouth above eyes
        np.zeros((3, 2), dtype=np.float32),  # wrong shape
    ],
)
def test_c11_degenerate_landmarks_give_no_box(bad: np.ndarray) -> None:
    assert locator.landmarks_to_box(DetectedFace(bad, 0.99), SHAPE) is None


def img() -> intake.Image:
    return np.zeros(SHAPE, dtype=np.uint8)


def test_c11_one_face_gives_one_box_and_low_confidence_is_dropped() -> None:
    assert len(locator.DetectorLocator(FakeDetector([face()]), CFG).locate(img())) == 1
    assert locator.DetectorLocator(FakeDetector([face(confidence=0.1)]), CFG).locate(img()) == []
    assert locator.DetectorLocator(FakeDetector([]), CFG).locate(img()) == []
    assert (
        len(locator.DetectorLocator(FakeDetector([face(confidence=None)]), CFG).locate(img())) == 1
    )


def test_c11_a_small_ghost_portrait_is_ignored_but_two_comparable_faces_stay_two() -> None:
    ghost = face(scaled(0.3, dx=60))
    assert len(locator.DetectorLocator(FakeDetector([face(), ghost]), CFG).locate(img())) == 1
    second = face(scaled(0.9, dx=-40))
    assert len(locator.DetectorLocator(FakeDetector([face(), second]), CFG).locate(img())) == 2


def write_id(folder: Path, name: str = "id.png") -> Path:
    """A 700 x 500 'ID card' with a 224 px face pasted at (330, 120) on a grey background."""
    import io

    card = PILImage.new("RGB", (700, 500), (180, 180, 180))
    card.paste(PILImage.open(io.BytesIO(synthetic_png(0))).convert("RGB"), (330, 120))
    p = folder / name
    card.save(p, format="PNG")
    return p


def on_card(landmarks: np.ndarray | None = None) -> np.ndarray:
    base = LANDMARKS if landmarks is None else landmarks
    return np.asarray(base + np.array([330.0, 120.0], dtype=np.float32), dtype=np.float32)


def test_c11_intake_with_the_detector_locator_keeps_only_the_portrait_and_deletes_the_original(
    tmp_path: Path,
) -> None:
    src = write_id(tmp_path)
    dest = tmp_path / "out" / "portrait.png"
    loc = locator.DetectorLocator(FakeDetector([face(on_card())]), CFG)
    intake.intake_id_photo(src, dest, loc)
    assert not src.exists() and dest.exists()
    with PILImage.open(dest) as im:
        assert im.width < 350 and im.height < 400  # the card is 700 x 500: the portrait only


@pytest.mark.parametrize(
    ("faces", "code"),
    [([], "NO_FACE"), ([face(on_card()), face(on_card(scaled(0.9, dx=-40)))], "MULTIPLE_FACES")],
)
def test_c11_failures_still_delete_the_original_and_write_nothing(
    tmp_path: Path, faces: list[DetectedFace], code: str
) -> None:
    src = write_id(tmp_path)
    dest = tmp_path / "portrait.png"
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, dest, locator.DetectorLocator(FakeDetector(faces), CFG))
    assert ei.value.code == code and not src.exists() and not dest.exists()


def test_c11_crop_cli_prints_fixed_text_only(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    src = write_id(tmp_path, "SECRET-name.png")
    dest = tmp_path / "SECRET-dest" / "p.png"
    assert (
        crop_id.run(src, dest, locator.DetectorLocator(FakeDetector([face(on_card())]), CFG)) == 0
    )
    out = capsys.readouterr()
    assert "SECRET" not in out.out + out.err and "original deleted" in out.out
    src2 = write_id(tmp_path, "SECRET-two.png")
    assert (
        crop_id.run(src2, tmp_path / "q.png", locator.DetectorLocator(FakeDetector([]), CFG)) == 2
    )
    out = capsys.readouterr()
    assert "NO_FACE" in out.err and "SECRET" not in out.out + out.err and not src2.exists()


def test_c22_crop_cli_refuses_a_landmarker_outside_the_cache_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(crop_id, "MODELS_DIR", tmp_path / "models")
    (tmp_path / "models").mkdir()
    monkeypatch.delenv("FACE_LANDMARKER_MODEL_PATH", raising=False)
    with pytest.raises(SystemExit, match="FACE_LANDMARKER_MODEL_PATH"):
        crop_id._check_landmarker_location()  # noqa: SLF001
    monkeypatch.setenv("FACE_LANDMARKER_MODEL_PATH", str(tmp_path / "elsewhere.task"))
    with pytest.raises(SystemExit):
        crop_id._check_landmarker_location()  # noqa: SLF001
    monkeypatch.setenv(
        "FACE_LANDMARKER_MODEL_PATH", str(tmp_path / "models" / "face_landmarker.task")
    )
    crop_id._check_landmarker_location()  # noqa: SLF001
