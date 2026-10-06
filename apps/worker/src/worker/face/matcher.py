"""Face matching orchestration: decode, detect, align, embed, compare, decide (FR-403, TC-033).

Every path ends in MATCH or MANUAL_REVIEW. There is no reject. Problems with the images or the
model are MANUAL_REVIEW with MATCH_ERROR, never a failure of the candidate. Embeddings stay in
memory: the only retained one is the selfie embedding in a small LRU cache, cleared at session end.
Logs carry exception type names and fixed codes only (never vectors, paths, keys, image bytes or
session ids). Detail codes are prefixed with the image role: ID_, SELFIE_ or FRAME_.
"""

from __future__ import annotations

import io
import logging
import threading
import time
from collections import OrderedDict
from typing import Final, Literal

import numpy as np
from PIL import Image as PILImage
from PIL import ImageOps, UnidentifiedImageError

from worker.config import FaceConfig
from worker.face.align import align_face
from worker.face.embedding import MODEL_ID, cosine
from worker.face.modelfile import ModelLoadError
from worker.face.types import (
    AlignedFace,
    DetectedFace,
    Embedding,
    EmbeddingError,
    FaceDecision,
    FaceDetector,
    FaceEmbedder,
    Image,
    MatchResult,
    ReviewReason,
)

log = logging.getLogger(__name__)

Role = Literal["ID", "SELFIE", "FRAME"]

# Pillow's decompression-bomb guard, set once at import (not per call) from the default limit; the
# configured limit is enforced explicitly in decode_image.
PILImage.MAX_IMAGE_PIXELS = FaceConfig().max_image_pixels
PILImage.init()
# Pillow opens phone MPO files (multi-picture JPEG) through its JPEG opener, so "JPEG" admits them;
# `im.format` then reads "MPO" and frame 0 is used. "MPO" is not itself a key in `formats`.
_ALLOWED_FORMATS: Final = ["JPEG", "PNG"]


class ImageError(ValueError):
    """Bad, oversized or corrupt image. Fixed code only."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _ReviewNeeded(Exception):
    def __init__(self, reason: ReviewReason, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


def decode_image(data: bytes, cfg: FaceConfig) -> Image:
    """Decode JPEG/PNG/MPO bytes to upright RGB uint8 with size and pixel limits.

    MPO uses its first frame. The EXIF orientation is applied AFTER the pixel-count check, so a
    rotated phone photo reaches the detector upright and a huge image is never transposed.
    """
    if not data or len(data) > cfg.max_image_bytes:
        raise ImageError("IMAGE_SIZE")
    try:
        with PILImage.open(io.BytesIO(data), formats=_ALLOWED_FORMATS) as im:
            if im.width * im.height > cfg.max_image_pixels:
                raise ImageError("IMAGE_SIZE")
            upright = ImageOps.exif_transpose(im)
            arr = np.asarray(upright.convert("RGB"), dtype=np.uint8)
    except ImageError:
        raise
    except PILImage.DecompressionBombError:
        raise ImageError("IMAGE_SIZE") from None
    except UnidentifiedImageError:
        raise ImageError("IMAGE_FORMAT_OR_CORRUPT") from None
    except Exception:
        raise ImageError("IMAGE_CORRUPT") from None
    return arr


class SelfieCache:
    """Bounded, thread-safe LRU of selfie embeddings keyed by session id (ADR 0004 section 2)."""

    def __init__(self, max_sessions: int) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be at least 1.")
        self._max = max_sessions
        self._items: OrderedDict[str, tuple[Embedding, float | None]] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, session_id: str, emb: Embedding, expires_at: float | None = None) -> None:
        """`expires_at` is epoch seconds (ADR 0014 6.3 TTL backstop); None means no expiry."""
        with self._lock:
            self._items[session_id] = (emb, expires_at)
            self._items.move_to_end(session_id)
            while len(self._items) > self._max:
                self._items.popitem(last=False)

    def get(self, session_id: str) -> Embedding | None:
        with self._lock:
            item = self._items.get(session_id)
            if item is None:
                return None
            emb, expires_at = item
            if expires_at is not None and expires_at <= time.time():
                del self._items[session_id]  # expired entries are dropped, not served
                return None
            self._items.move_to_end(session_id)
            return emb

    def clear_session(self, session_id: str) -> None:
        """Call when the session ends (submitted, expired, erased)."""
        with self._lock:
            self._items.pop(session_id, None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def __repr__(self) -> str:
        return f"SelfieCache(size={len(self)}, redacted)"


def _size(face: DetectedFace) -> float:
    """Face size from its landmarks: the larger side of their bounding box."""
    pts = face.landmarks
    return float(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])))


face_size = _size  # public: the ID-photo ghost-portrait rule is shared with the INT-01 locator


class FaceMatcher:
    """The face-matching interface of ADR 0004 section 2 plus the decision flow."""

    def __init__(
        self, detector: FaceDetector, embedder: FaceEmbedder, config: FaceConfig | None = None
    ) -> None:
        self._detector = detector
        self._embedder = embedder
        # Default to the system configuration (FACE_* env), never to silent built-in defaults.
        self.config = config if config is not None else FaceConfig.from_env()
        self.selfie_cache = SelfieCache(self.config.selfie_cache_max_sessions)

    # --- D-05 interface ---

    @property
    def model_id(self) -> str:
        return self._embedder.model_id

    def detect_and_align(self, image: Image) -> list[AlignedFace]:
        """Aligned 112x112 crops for each usable face (low-confidence detections are dropped)."""
        return [align_face(image, f.landmarks) for f in self._usable(self._detector.detect(image))]

    def embed(self, aligned: AlignedFace) -> Embedding:
        return self._embedder.embed(aligned)

    def compare(self, a: Embedding, b: Embedding) -> float:
        return cosine(a, b)

    # --- decision flow ---

    def match(
        self,
        id_image: bytes,
        selfie_image: bytes,
        *,
        liveness_confirmed: bool,
        session_id: str | None = None,
        expires_at: float | None = None,
    ) -> MatchResult:
        """ID photo vs selfie. The ID embedding is dropped as soon as the score is computed.

        `liveness_confirmed` has no default on purpose (fail-closed): the caller must say what the
        client reported. Anything other than True (False, None) is MANUAL_REVIEW, and liveness can
        only ever lead to manual review (ADR 0004 section 1).

        The ID photo may hold a small secondary portrait (ghost image); the selfie must hold exactly
        one face. The selfie embedding is cached only after the comparison succeeded.
        """
        try:
            if liveness_confirmed is not True:
                raise _ReviewNeeded(ReviewReason.LIVENESS_NOT_CONFIRMED, "LIVENESS")
            id_emb = self._embed_single(id_image, "ID")
            selfie_emb = self._embed_single(selfie_image, "SELFIE")
            score = self.compare(id_emb, selfie_emb)
            if session_id is not None:
                self.selfie_cache.put(session_id, selfie_emb, expires_at)
            return self._decide(score)
        except Exception as e:
            return self._failure(e, "match")

    def recheck_with_selfie(self, frame_image: bytes, selfie_image: bytes) -> MatchResult:
        """FR-606 re-check with no cache (ADR 0014 6.3 default): both embeddings are computed for
        this one comparison and dropped. Selfie problems carry a SELFIE_ detail prefix."""
        try:
            frame_emb = self._embed_single(frame_image, "FRAME")
            selfie_emb = self._embed_single(selfie_image, "SELFIE")
            return self._decide(self.compare(frame_emb, selfie_emb))
        except Exception as e:
            return self._failure(e, "recheck")

    def prime_selfie(
        self, session_id: str, selfie_image: bytes, expires_at: float | None = None
    ) -> MatchResult | None:
        """Recompute and cache just the selfie embedding after a cache miss or restart (ADR 0004
        section 2), through the strict single-face SELFIE path. The ID image is not touched.
        Returns None on success, or a MANUAL_REVIEW result if the selfie cannot be used."""
        try:
            emb = self._embed_single(selfie_image, "SELFIE")
            self.selfie_cache.put(session_id, emb, expires_at)
            return None
        except Exception as e:
            return self._failure(e, "prime")

    def recheck(self, session_id: str, frame_image: bytes) -> MatchResult:
        """FR-606 periodic re-check against the cached selfie. A miss is MATCH_ERROR/CACHE_MISS;
        the caller recomputes the selfie embedding from the stored selfie and retries."""
        try:
            selfie_emb = self.selfie_cache.get(session_id)
            if selfie_emb is None:
                raise _ReviewNeeded(ReviewReason.MATCH_ERROR, "CACHE_MISS")
            frame_emb = self._embed_single(frame_image, "FRAME")
            return self._decide(self.compare(frame_emb, selfie_emb))
        except Exception as e:
            return self._failure(e, "recheck")

    def end_session(self, session_id: str) -> None:
        self.selfie_cache.clear_session(session_id)

    # --- internals ---

    def _failure(self, e: Exception, op: str) -> MatchResult:
        if isinstance(e, _ReviewNeeded):
            return self._review(e.reason, e.detail)
        if isinstance(e, ImageError | EmbeddingError | ModelLoadError):
            return self._review(ReviewReason.MATCH_ERROR, e.code)
        log.warning("face %s failed: %s", op, type(e).__name__)
        return self._review(ReviewReason.MATCH_ERROR, "UNEXPECTED")

    def _usable(self, faces: list[DetectedFace]) -> list[DetectedFace]:
        floor = self.config.min_detection_confidence
        return [f for f in faces if f.confidence is None or f.confidence >= floor]

    def _embed_single(self, data: bytes, role: Role) -> Embedding:
        """Decode, find exactly one face, align and embed. Failures carry a role-prefixed code."""
        try:
            image = decode_image(data, self.config)
            faces = self._detector.detect(image)
            usable = self._usable(faces)
            if role == "ID" and len(usable) > 1:
                # Keep the largest face; smaller ones (ghost portrait) are ignored, but a second
                # face of comparable size is still MULTIPLE_FACES.
                usable.sort(key=_size, reverse=True)
                floor = self.config.id_secondary_face_ratio * _size(usable[0])
                usable = [f for f in usable if _size(f) >= floor]
            if len(usable) > 1:
                raise _ReviewNeeded(ReviewReason.MULTIPLE_FACES, f"{role}_MULTIPLE_FACES")
            if not usable:
                detail = "LOW_DETECTION_CONFIDENCE" if faces else "NO_FACE"
                raise _ReviewNeeded(ReviewReason.NO_FACE, f"{role}_{detail}")
            try:
                aligned = align_face(image, usable[0].landmarks)
            except ValueError:
                raise _ReviewNeeded(
                    ReviewReason.MATCH_ERROR, f"{role}_DEGENERATE_LANDMARKS"
                ) from None
            return self.embed(aligned)
        except _ReviewNeeded:
            raise
        except (ImageError, EmbeddingError) as e:
            raise _ReviewNeeded(ReviewReason.MATCH_ERROR, f"{role}_{e.code}") from None
        except Exception as e:
            log.warning("face %s step failed: %s", role, type(e).__name__)
            raise _ReviewNeeded(ReviewReason.MATCH_ERROR, f"{role}_UNEXPECTED") from None

    def _decide(self, score: float) -> MatchResult:
        if not np.isfinite(score):
            return self._review(ReviewReason.MATCH_ERROR, "NON_FINITE_SCORE")
        if score >= self.config.match_threshold:
            return MatchResult(
                FaceDecision.MATCH, None, None, score, self.model_id, self.config.match_threshold
            )
        return self._review(ReviewReason.BELOW_THRESHOLD, "BELOW_THRESHOLD", score)

    def _review(self, reason: ReviewReason, detail: str, score: float | None = None) -> MatchResult:
        return MatchResult(
            FaceDecision.MANUAL_REVIEW,
            reason,
            detail,
            score,
            self.model_id,
            self.config.match_threshold,
        )


def review_for_model_error(err: ModelLoadError, config: FaceConfig | None = None) -> MatchResult:
    """Model refused or unavailable (hash mismatch, wrong file, not set): MANUAL_REVIEW, never a
    failure of the candidate (ADR 0004 section 1: MATCH_ERROR goes to review at once)."""
    cfg = config if config is not None else FaceConfig.from_env()
    return MatchResult(
        FaceDecision.MANUAL_REVIEW,
        ReviewReason.MATCH_ERROR,
        err.code,
        None,
        MODEL_ID,
        cfg.match_threshold,
    )
