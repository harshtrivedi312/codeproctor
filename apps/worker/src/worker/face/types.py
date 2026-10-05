"""Shared types for face matching."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

import numpy as np
import numpy.typing as npt

# RGB, uint8, height x width x 3.
Image = npt.NDArray[np.uint8]
Landmarks5 = npt.NDArray[
    np.float32
]  # shape (5, 2): left eye, right eye, nose, left mouth, right mouth

ALIGNED_SIZE = 112


class FaceDecision(StrEnum):
    """The only two outcomes. There is deliberately no reject or fail member (D-05, FR-403)."""

    MATCH = "MATCH"
    MANUAL_REVIEW = "MANUAL_REVIEW"


class ReviewReason(StrEnum):
    """Mirrors the database enum `identity_review_reason` (ADR 0004 section 1)."""

    BELOW_THRESHOLD = "BELOW_THRESHOLD"
    NO_FACE = "NO_FACE"
    MULTIPLE_FACES = "MULTIPLE_FACES"
    LIVENESS_NOT_CONFIRMED = "LIVENESS_NOT_CONFIRMED"
    MATCH_ERROR = "MATCH_ERROR"


@dataclass(frozen=True, slots=True)
class DetectedFace:
    """One face from a detector. `confidence` is None when the detector reports none."""

    landmarks: Landmarks5
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class AlignedFace:
    """A 112x112 RGB crop ready for the embedder. Biometric data: never persisted or logged."""

    pixels: Image

    def __repr__(self) -> str:
        return "AlignedFace(112x112, redacted)"


@dataclass(frozen=True, slots=True)
class MatchResult:
    """What the API stores on `identity_checks`: decision, reason, score, model_id, threshold.

    `detail` is a short fixed code (never free text from an exception) for logs and support.
    """

    decision: FaceDecision
    reason: ReviewReason | None
    detail: str | None
    score: float | None
    model_id: str
    threshold: float


class FaceDetector(Protocol):
    """Swappable detector (MediaPipe in production, a fake in tests)."""

    def detect(self, image: Image) -> list[DetectedFace]: ...


class FaceEmbedder(Protocol):
    """Swappable embedding model (AuraFace in production)."""

    @property
    def model_id(self) -> str: ...

    def embed(self, aligned: AlignedFace) -> Embedding: ...


class Embedding:
    """A face embedding. In memory only: no persistence, no logging, no repr of values.

    Pickling and copying are refused so an embedding cannot be written out by accident.
    """

    __slots__ = ("_v",)

    def __init__(self, vector: npt.NDArray[np.float32]) -> None:
        if vector.ndim != 1 or vector.dtype != np.float32 or vector.size == 0:
            raise EmbeddingError("SHAPE_OR_DTYPE")
        if not np.all(np.isfinite(vector)):
            raise EmbeddingError("NON_FINITE")
        if float(np.linalg.norm(vector)) < 1e-12:
            raise EmbeddingError("ZERO_NORM")
        v = vector.copy()
        v.setflags(write=False)
        self._v = v

    @property
    def vector(self) -> npt.NDArray[np.float32]:
        return self._v

    @property
    def dim(self) -> int:
        return int(self._v.shape[0])

    def __repr__(self) -> str:
        return f"Embedding(dim={self.dim}, redacted)"

    __str__ = __repr__

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Embeddings must not be serialized.")

    def __copy__(self) -> Embedding:
        raise TypeError("Embeddings must not be copied.")

    def __deepcopy__(self, memo: dict[int, object]) -> Embedding:
        raise TypeError("Embeddings must not be copied.")


class EmbeddingError(ValueError):
    """Raised with a fixed code only; never includes vector values."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
