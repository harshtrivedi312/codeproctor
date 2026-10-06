"""Crop-and-delete intake for a volunteer's ID photo (volunteer form section 2, C-11).

Only the portrait is kept. The original is deleted as soon as the crop is safely written, and it
is deleted even when no single face is found, so a failed upload never leaves a full ID on disk.
Re-encoding from pixels drops EXIF and other metadata. Nothing is logged except fixed codes.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
import numpy.typing as npt

from tools.int01.safety import inside_git_tree

Image = npt.NDArray[np.uint8]  # RGB, height x width x 3


@dataclass(frozen=True, slots=True)
class Box:
    """Pixel box, x0/y0 inclusive, x1/y1 exclusive."""

    x0: int
    y0: int
    x1: int
    y1: int


class FaceLocator(Protocol):
    """Returns one box per face found. Adapter over the worker's detector (after #59)."""

    def locate(self, image: Image) -> list[Box]: ...


class IntakeError(Exception):
    """Fixed code only: NO_FACE, MULTIPLE_FACES, UNREADABLE, WRITE_FAILED, DELETE_FAILED,
    PATH_REFUSED, DETECTOR_FAILED."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


DEFAULT_MARGIN = 0.35  # for a tight detector box; a full-face box needs far less (see locator)


def crop_portrait(image: Image, box: Box, margin: float = DEFAULT_MARGIN) -> Image:
    """Crop the face box plus a margin (fraction of box size), clamped to the image."""
    h, w = image.shape[:2]
    mx = int((box.x1 - box.x0) * margin)
    my = int((box.y1 - box.y0) * margin)
    x0, y0 = max(0, box.x0 - mx), max(0, box.y0 - my)
    x1, y1 = min(w, box.x1 + mx), min(h, box.y1 + my)
    if x1 <= x0 or y1 <= y0:
        raise IntakeError("NO_FACE")
    return image[y0:y1, x0:x1].copy()


def _load(path: Path) -> Image:
    from PIL import Image as PILImage  # lazy: Pillow is only needed for file intake
    from PIL import ImageOps

    try:
        with PILImage.open(path) as im:
            return np.asarray(ImageOps.exif_transpose(im).convert("RGB"), dtype=np.uint8)
    except Exception:  # noqa: BLE001 - any decode failure maps to one fixed code
        raise IntakeError("UNREADABLE") from None  # PIL messages can carry the file path


def _delete_original(path: Path) -> bool:
    """Best effort: zero the bytes, then unlink. Returns False if the file could not be removed.
    SSD wear levelling can keep old blocks, so originals should sit on an encrypted volume."""
    try:
        size = path.stat().st_size
        with path.open("r+b") as fh:
            fh.write(b"\0" * size)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError:
        pass  # still try to unlink below
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return False
    return not path.exists()


def intake_id_photo(
    src: Path, dest: Path, locator: FaceLocator, margin: float = DEFAULT_MARGIN
) -> Path:
    """Write the portrait crop to `dest` (PNG, mode 0600) and delete `src`. Returns `dest`.

    `src` is deleted on success and on every failure after the paths are accepted. If it cannot
    be deleted, DELETE_FAILED is raised instead, so the problem is never silent. Paths inside a
    git tree, symlinks, and src == dest are refused before anything is touched.
    """
    from PIL import Image as PILImage

    if (
        src.is_symlink()
        or not src.is_file()
        or src.resolve() == dest.resolve()
        or inside_git_tree(src)
        or inside_git_tree(dest)
    ):
        raise IntakeError("PATH_REFUSED")
    error: IntakeError | None = None
    try:
        image = _load(src)
        boxes = locator.locate(image)
        if not boxes:
            raise IntakeError("NO_FACE")
        if len(boxes) > 1:
            raise IntakeError("MULTIPLE_FACES")
        crop = crop_portrait(image, boxes[0], margin)
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=dest.parent, suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as fh:
                PILImage.fromarray(crop, "RGB").save(fh, format="PNG")
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, dest)
        except BaseException:
            tmp.unlink(missing_ok=True)  # never leave a crop behind
            raise
    except IntakeError as exc:
        error = exc
    except OSError:
        error = IntakeError("WRITE_FAILED")
    finally:
        deleted = _delete_original(src)
    if not deleted:
        dest.unlink(missing_ok=True)
        raise IntakeError("DELETE_FAILED") from None
    if error is not None:
        raise error from None
    return dest
