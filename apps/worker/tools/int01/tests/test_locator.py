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
    big = (700, 500, 3)
    box = locator.landmarks_to_box(face(on_card()), big)
    assert box is not None
    for x, y in on_card():
        assert box.x0 <= x <= box.x1 and box.y0 <= y <= box.y1
    assert 0 <= box.x0 < box.x1 <= 700 and 0 <= box.y0 < box.y1 <= 500
    # near an edge the box is clamped, never negative or past the image
    edge = locator.landmarks_to_box(face(on_card(scaled(1.0, dx=-400))), big)
    assert edge is not None and edge.x0 == 0 and edge.x1 <= 700


def test_c11_implausible_proportions_and_oversized_boxes_give_no_box() -> None:
    wide = np.array([[0, 100], [220, 100], [110, 120], [60, 130], [160, 130]], dtype=np.float32)
    assert locator.landmarks_to_box(DetectedFace(wide, 0.99), SHAPE) is None  # drop/eye = 0.14
    long = np.array([[90, 10], [130, 10], [110, 100], [95, 200], [125, 200]], dtype=np.float32)
    assert locator.landmarks_to_box(DetectedFace(long, 0.99), SHAPE) is None  # drop/eye = 4.75
    # a plausible face that fills the image is not a portrait on a card: refuse it
    assert locator.landmarks_to_box(face(), (230, 190, 3)) is None


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
    card = np.zeros((500, 700, 3), dtype=np.uint8)
    one = locator.DetectorLocator(FakeDetector([face(on_card())]), CFG)
    assert len(one.locate(card)) == 1
    low = locator.DetectorLocator(FakeDetector([face(on_card(), confidence=0.1)]), CFG)
    assert low.locate(card) == []
    assert locator.DetectorLocator(FakeDetector([]), CFG).locate(card) == []
    none = locator.DetectorLocator(FakeDetector([face(on_card(), confidence=None)]), CFG)
    assert len(none.locate(card)) == 1


def test_c11_a_small_ghost_portrait_is_ignored_but_two_comparable_faces_refuse() -> None:
    ghost = face(scaled(0.3, dx=60))
    assert len(locator.DetectorLocator(FakeDetector([face(), ghost]), CFG).locate(img())) == 1
    second = face(scaled(0.9, dx=-40))
    with pytest.raises(intake.IntakeError) as ei:
        locator.DetectorLocator(FakeDetector([face(), second]), CFG).locate(img())
    assert ei.value.code == "MULTIPLE_FACES"


def write_id(folder: Path, name: str = "id.png") -> Path:
    """A 700 x 500 'ID card' with a 224 px face pasted at (330, 120) on a grey background."""
    import io

    card = PILImage.new("RGB", (700, 500), (180, 180, 180))
    card.paste(PILImage.open(io.BytesIO(synthetic_png(0))).convert("RGB"), (330, 120))
    p = folder / name
    card.save(p, format="PNG")
    return p


def upside_down() -> np.ndarray:
    """Comparable size but mouth above eyes: too odd to box, still a second face."""
    flipped = LANDMARKS.copy()
    flipped[:, 1] = 224 - flipped[:, 1]
    return np.asarray(flipped + np.array([40.0, 120.0], dtype=np.float32), dtype=np.float32)


def on_card(landmarks: np.ndarray | None = None) -> np.ndarray:
    base = LANDMARKS if landmarks is None else landmarks
    return np.asarray(base + np.array([330.0, 120.0], dtype=np.float32), dtype=np.float32)


def test_c11_the_kept_png_is_the_face_box_plus_a_thin_margin_and_stays_inside_the_pasted_tile(
    tmp_path: Path,
) -> None:
    src = write_id(tmp_path)
    card = np.asarray(PILImage.open(src).convert("RGB"), dtype=np.uint8).copy()
    dest = tmp_path / "out" / "portrait.png"
    lm = on_card()
    loc = locator.DetectorLocator(FakeDetector([face(lm)]), CFG)
    intake.intake_id_photo(src, dest, loc, locator.LOCATOR_MARGIN)
    assert not src.exists() and dest.exists()
    kept = np.asarray(PILImage.open(dest).convert("RGB"), dtype=np.uint8)
    box = locator.landmarks_to_box(face(lm), card.shape)
    assert box is not None
    expected = intake.crop_portrait(card, box, locator.LOCATOR_MARGIN)
    assert kept.shape == expected.shape and np.array_equal(kept, expected)
    # the pasted 224 px tile spans x 330..554, y 120..344: the crop may not run past it by more
    # than a few pixels, so none of the grey card around it (where printed text would sit) is kept
    h, w = kept.shape[:2]
    assert w <= 224 + 8 and h <= 224 + 8
    grey = np.all(kept == 180, axis=2)
    assert grey.mean() < 0.15  # almost nothing but the face tile


@pytest.mark.parametrize(
    ("faces", "code"),
    [
        ([], "NO_FACE"),
        ([face(on_card()), face(on_card(scaled(0.9, dx=-40)))], "MULTIPLE_FACES"),
        # a comparable second face with odd landmarks still refuses (the matcher would too)
        ([face(on_card()), face(upside_down())], "MULTIPLE_FACES"),
    ],
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


@pytest.mark.parametrize(
    "error", [RuntimeError("SECRET-detail"), MemoryError(), OSError("SECRET-path"), IndexError()]
)
def test_c11_any_detector_failure_is_a_fixed_code_and_the_original_is_still_deleted(
    tmp_path: Path, error: Exception, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(_img: object) -> list[DetectedFace]:
        raise error

    src = write_id(tmp_path)
    dest = tmp_path / "p.png"
    code = crop_id.run(src, dest, locator.DetectorLocator(FakeDetector(boom), CFG))
    out = capsys.readouterr()
    assert code == 2 and "DETECTOR_FAILED" in out.err and "SECRET" not in out.err + out.out
    assert not src.exists() and not dest.exists()


def test_c11_an_unexpected_error_in_the_cli_is_a_fixed_code_not_a_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    class Weird:
        def locate(self, image: intake.Image) -> list[intake.Box]:
            raise ValueError("SECRET")

    # intake maps an unexpected error to the fixed code UNEXPECTED; the CLI stays quiet too
    src = write_id(tmp_path)
    assert crop_id.run(src, tmp_path / "p.png", Weird()) == 2
    out = capsys.readouterr()
    assert "UNEXPECTED" in out.err and "SECRET" not in out.err + out.out and not src.exists()


def test_c22_symlinks_and_git_trees_are_refused_for_the_landmarker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    models = tmp_path / "models"
    models.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "m.task").write_bytes(b"x")
    (models / "link.task").symlink_to(outside / "m.task")  # inside the folder, points outside
    monkeypatch.setattr(crop_id, "MODELS_DIR", models)
    monkeypatch.setenv("FACE_LANDMARKER_MODEL_PATH", str(models / "link.task"))
    with pytest.raises(SystemExit):
        crop_id._check_landmarker_location()  # noqa: SLF001
    folder_link = tmp_path / "models-link"
    folder_link.symlink_to(models)
    monkeypatch.setattr(crop_id, "MODELS_DIR", folder_link)
    monkeypatch.setenv("FACE_LANDMARKER_MODEL_PATH", str(folder_link / "x.task"))
    with pytest.raises(SystemExit):
        crop_id._check_landmarker_location()  # noqa: SLF001
    repo_models = tmp_path / "repo" / "models"
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    repo_models.mkdir()
    monkeypatch.setattr(crop_id, "MODELS_DIR", repo_models)
    monkeypatch.setenv("FACE_LANDMARKER_MODEL_PATH", str(repo_models / "m.task"))
    with pytest.raises(SystemExit):
        crop_id._check_landmarker_location()  # noqa: SLF001


def test_c11_a_failed_delete_is_reported_even_behind_an_unexpected_error_and_spares_other_crops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Weird:
        def locate(self, image: intake.Image) -> list[intake.Box]:
            raise ValueError("SECRET")

    src = write_id(tmp_path)
    earlier = tmp_path / "earlier-volunteer.png"
    earlier.write_bytes(b"someone else's crop")
    monkeypatch.setattr(intake, "_delete_original", lambda p: False)
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, earlier, Weird())
    assert ei.value.code == "DELETE_FAILED"
    assert (
        earlier.read_bytes() == b"someone else's crop"
    )  # this call wrote nothing, so it removes nothing
