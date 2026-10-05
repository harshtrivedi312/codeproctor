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
    """Carries a fixed code only: NO_FACE, MULTIPLE_FACES, UNREADABLE, WRITE_FAILED."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def crop_portrait(image: Image, box: Box, margin: float = 0.35) -> Image:
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

    try:
        with PILImage.open(path) as im:
            return np.asarray(im.convert("RGB"), dtype=np.uint8)
    except Exception as exc:  # noqa: BLE001 - any decode failure maps to one fixed code
        raise IntakeError("UNREADABLE") from exc


def _overwrite_and_unlink(path: Path) -> None:
    """Best effort: zero the bytes before unlinking. SSD wear levelling can keep old blocks, so
    volunteers' originals should also sit on an encrypted volume (form section 5)."""
    try:
        size = path.stat().st_size
        with path.open("r+b") as fh:
            fh.write(b"\0" * size)
            fh.flush()
            os.fsync(fh.fileno())
    finally:
        path.unlink(missing_ok=True)


def intake_id_photo(src: Path, dest: Path, locator: FaceLocator) -> Path:
    """Write the portrait crop to `dest` (PNG, mode 0600) and delete `src`. Returns `dest`.

    `src` is always deleted, on success and on failure.
    """
    from PIL import Image as PILImage

    try:
        image = _load(src)
        boxes = locator.locate(image)
        if not boxes:
            raise IntakeError("NO_FACE")
        if len(boxes) > 1:
            raise IntakeError("MULTIPLE_FACES")
        crop = crop_portrait(image, boxes[0])
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
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            raise IntakeError("WRITE_FAILED") from exc
        return dest
    finally:
        _overwrite_and_unlink(src)
