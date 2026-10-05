"""Face matching orchestration: decode, detect, align, embed, compare, decide (FR-403, TC-033).

Every path ends in MATCH or MANUAL_REVIEW. There is no reject. Problems with the images or the
model are MANUAL_REVIEW with MATCH_ERROR, never a failure of the candidate. Embeddings stay in
memory: the only retained one is the selfie embedding in a small LRU cache, cleared at session end.
Logs carry fixed codes only (never vectors, paths, keys or image bytes).
"""

from __future__ import annotations

import io
import logging
from collections import OrderedDict

import numpy as np

from worker.config import FaceConfig
from worker.face.align import align_face
from worker.face.embedding import MODEL_ID, ModelLoadError, cosine
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
    """Decode JPEG/PNG bytes to RGB uint8 with size and pixel limits (decompression-bomb guard)."""
    if not data or len(data) > cfg.max_image_bytes:
        raise ImageError("IMAGE_SIZE")
    from PIL import Image as PILImage

    try:
        PILImage.MAX_IMAGE_PIXELS = cfg.max_image_pixels
        with PILImage.open(io.BytesIO(data)) as im:
            if im.format not in ("JPEG", "PNG"):
                raise ImageError("IMAGE_FORMAT")
            if im.width * im.height > cfg.max_image_pixels:
                raise ImageError("IMAGE_SIZE")
            arr = np.asarray(im.convert("RGB"), dtype=np.uint8)
    except ImageError:
        raise
    except PILImage.DecompressionBombError:
        raise ImageError("IMAGE_SIZE") from None
    except Exception:
        raise ImageError("IMAGE_CORRUPT") from None
    return arr


class SelfieCache:
    """Bounded LRU of selfie embeddings keyed by session id (ADR 0004 section 2). Memory only."""

    def __init__(self, max_sessions: int) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be at least 1.")
        self._max = max_sessions
        self._items: OrderedDict[str, Embedding] = OrderedDict()

    def put(self, session_id: str, emb: Embedding) -> None:
        self._items[session_id] = emb
        self._items.move_to_end(session_id)
        while len(self._items) > self._max:
            self._items.popitem(last=False)

    def get(self, session_id: str) -> Embedding | None:
        emb = self._items.get(session_id)
        if emb is not None:
            self._items.move_to_end(session_id)
        return emb

    def clear_session(self, session_id: str) -> None:
        """Call when the session ends (submitted, expired, erased)."""
        self._items.pop(session_id, None)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)

    def __repr__(self) -> str:
        return f"SelfieCache(size={len(self._items)}, redacted)"


class FaceMatcher:
    """The face-matching interface of ADR 0004 section 2 plus the decision flow."""

    def __init__(
        self, detector: FaceDetector, embedder: FaceEmbedder, config: FaceConfig | None = None
    ) -> None:
        self._detector = detector
        self._embedder = embedder
        self.config = config or FaceConfig()
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
        session_id: str | None = None,
        liveness_confirmed: bool = True,
    ) -> MatchResult:
        """ID photo vs selfie. The ID embedding is dropped as soon as the score is computed."""
        try:
            if not liveness_confirmed:
                raise _ReviewNeeded(ReviewReason.LIVENESS_NOT_CONFIRMED, "LIVENESS")
            id_emb = self._embed_single(id_image)
            selfie_emb = self._embed_single(selfie_image)
            if session_id is not None:
                self.selfie_cache.put(session_id, selfie_emb)
            return self._decide(self.compare(id_emb, selfie_emb))
        except _ReviewNeeded as r:
            return self._review(r.reason, r.detail)
        except (ImageError, EmbeddingError) as e:
            return self._review(ReviewReason.MATCH_ERROR, e.code)
        except Exception:
            log.warning("face match failed: UNEXPECTED")
            return self._review(ReviewReason.MATCH_ERROR, "UNEXPECTED")

    def recheck(self, session_id: str, frame_image: bytes) -> MatchResult:
        """FR-606 periodic re-check against the cached selfie. A miss is MATCH_ERROR/CACHE_MISS;
        the caller recomputes the selfie embedding from the stored selfie and retries."""
        try:
            selfie_emb = self.selfie_cache.get(session_id)
            if selfie_emb is None:
                raise _ReviewNeeded(ReviewReason.MATCH_ERROR, "CACHE_MISS")
            return self._decide(self.compare(self._embed_single(frame_image), selfie_emb))
        except _ReviewNeeded as r:
            return self._review(r.reason, r.detail)
        except (ImageError, EmbeddingError) as e:
            return self._review(ReviewReason.MATCH_ERROR, e.code)
        except Exception:
            log.warning("face recheck failed: UNEXPECTED")
            return self._review(ReviewReason.MATCH_ERROR, "UNEXPECTED")

    def end_session(self, session_id: str) -> None:
        self.selfie_cache.clear_session(session_id)

    # --- internals ---

    def _usable(self, faces: list[DetectedFace]) -> list[DetectedFace]:
        floor = self.config.min_detection_confidence
        return [f for f in faces if f.confidence is None or f.confidence >= floor]

    def _embed_single(self, data: bytes) -> Embedding:
        image = decode_image(data, self.config)
        faces = self._detector.detect(image)
        usable = self._usable(faces)
        if len(usable) > 1:
            raise _ReviewNeeded(ReviewReason.MULTIPLE_FACES, "MULTIPLE_FACES")
        if not usable:
            detail = "LOW_DETECTION_CONFIDENCE" if faces else "NO_FACE"
            raise _ReviewNeeded(ReviewReason.NO_FACE, detail)
        return self.embed(align_face(image, usable[0].landmarks))

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
    cfg = config or FaceConfig()
    return MatchResult(
        FaceDecision.MANUAL_REVIEW,
        ReviewReason.MATCH_ERROR,
        err.code,
        None,
        MODEL_ID,
        cfg.match_threshold,
    )
