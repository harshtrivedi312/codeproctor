"""Synthetic images and fake detector/embedder for face tests. No photos of real people."""

from __future__ import annotations

import io
from collections.abc import Callable, Sequence

import numpy as np
import numpy.typing as npt
from PIL import Image as PILImage
from PIL import ImageDraw

from worker.face.types import AlignedFace, DetectedFace, Embedding, Image

SIZE = 224
# Landmarks (left eye, right eye, nose, left mouth, right mouth) of the drawn synthetic face.
LANDMARKS = np.array([[80, 90], [144, 90], [112, 120], [88, 156], [136, 156]], dtype=np.float32)


def synthetic_png(identity: int = 0, size: int = SIZE) -> bytes:
    """A drawn cartoon face. `identity` changes the nose-area colour, which the fake embedder reads."""
    im = PILImage.new("RGB", (size, size), (200, 200, 200))
    d = ImageDraw.Draw(im)
    d.ellipse((50, 40, 174, 190), fill=(220, 180, 150))
    for x, y in LANDMARKS[:2]:
        d.ellipse((x - 6, y - 4, x + 6, y + 4), fill=(20, 20, 20))
    nose = (30 + 40 * (identity % 6), 100 + 25 * (identity // 6 % 6), 60 + 30 * (identity % 5))
    d.polygon([(112, 105), (104, 126), (120, 126)], fill=nose)
    d.line((88, 156, 136, 156), fill=(120, 40, 40), width=3)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def to_array(png: bytes) -> Image:
    return np.asarray(PILImage.open(io.BytesIO(png)).convert("RGB"), dtype=np.uint8)


class FakeDetector:
    """Returns configured faces; records calls."""

    def __init__(
        self,
        faces: Sequence[DetectedFace] | Callable[[Image], list[DetectedFace]] | None = None,
    ) -> None:
        self._faces = faces if faces is not None else [DetectedFace(LANDMARKS.copy(), 0.99)]
        self.calls = 0

    def detect(self, image: Image) -> list[DetectedFace]:
        self.calls += 1
        if callable(self._faces):
            return self._faces(image)
        return list(self._faces)


def vector_for(key: bytes, dim: int = 512) -> npt.NDArray[np.float32]:
    seed = int.from_bytes(key[:8].ljust(8, b"\0"), "big")
    return np.random.default_rng(seed).standard_normal(dim).astype(np.float32)


class FakeEmbedder:
    """Deterministic: the vector depends on the colour at the centre of the aligned crop."""

    def __init__(self, dim: int = 512, fail: Exception | None = None) -> None:
        self._dim = dim
        self._fail = fail
        self.calls = 0

    @property
    def model_id(self) -> str:
        return "fake:1"

    def embed(self, aligned: AlignedFace) -> Embedding:
        self.calls += 1
        if self._fail is not None:
            raise self._fail
        return Embedding(vector_for(bytes(aligned.pixels[60:66, 56, :].ravel()), self._dim))


class FixedEmbedder:
    """Returns queued embeddings, for exact-cosine boundary tests."""

    def __init__(self, vectors: Sequence[Sequence[float]]) -> None:
        self._queue = list(vectors)

    @property
    def model_id(self) -> str:
        return "fixed:1"

    def embed(self, aligned: AlignedFace) -> Embedding:
        return Embedding(np.asarray(self._queue.pop(0), dtype=np.float32))
