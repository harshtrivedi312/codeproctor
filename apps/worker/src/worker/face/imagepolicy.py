"""Per-role image caps checked BEFORE decoding (ADR 0014 6.2, ADR 0013 5.6).

ID image and selfie: JPEG, at most 5 MiB, at most 25 megapixels. Re-check frame: JPEG, at most
1 MiB, at most 1920 x 1920, read from the JPEG header without decoding any pixels. Anything else
is a fixed code, which the face routes turn into MANUAL_REVIEW / MATCH_ERROR (D-05).
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Final, Literal

from PIL import Image as PILImage

Role = Literal["ID", "SELFIE", "FRAME"]
_JPEG_MAGIC: Final = b"\xff\xd8\xff"


@dataclass(frozen=True, slots=True)
class RolePolicy:
    max_bytes: int
    max_pixels: int
    max_side: int | None = None


POLICIES: Final[dict[Role, RolePolicy]] = {
    "ID": RolePolicy(5 * 1024 * 1024, 25_000_000),
    "SELFIE": RolePolicy(5 * 1024 * 1024, 25_000_000),
    "FRAME": RolePolicy(1 * 1024 * 1024, 1920 * 1920, 1920),
}


class ImagePolicyError(ValueError):
    """Fixed code, prefixed with the role: `ID_IMAGE_SIZE`, `FRAME_DIMENSIONS`, ..."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def check_image(role: Role, data: bytes) -> None:
    """Raise ImagePolicyError unless `data` is a JPEG within the role's caps. No pixel decoding."""
    policy = POLICIES[role]
    if not data or len(data) > policy.max_bytes:
        raise ImagePolicyError(f"{role}_IMAGE_SIZE")
    if not data.startswith(_JPEG_MAGIC):
        raise ImagePolicyError(f"{role}_NOT_JPEG")
    try:
        with PILImage.open(io.BytesIO(data), formats=["JPEG"]) as im:  # header only: lazy
            width, height = im.size
    except Exception:
        raise ImagePolicyError(f"{role}_IMAGE_CORRUPT") from None
    if width < 1 or height < 1 or width * height > policy.max_pixels:
        raise ImagePolicyError(f"{role}_DIMENSIONS")
    if policy.max_side is not None and max(width, height) > policy.max_side:
        raise ImagePolicyError(f"{role}_DIMENSIONS")
