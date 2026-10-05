"""AuraFace glintr100.onnx embedder (D-05, ADR 0004 section 2, ADR 0001 sections 12.2 and F-1).

Only the recognition model file `glintr100.onnx` from fal/AuraFace-v1 is ever loaded, from a local
path (env var `AURAFACE_MODEL_PATH`), after its SHA-256 matches the pin. Any other file name or
digest is refused. No InsightFace file (scrfd, 2d106det, 1k3d68, genderage) is ever loaded (F-1).
The model is never downloaded by this code (owner approval P-07).

Input float32 [1, 3, 112, 112] RGB scaled to (x - 127.5) / 127.5; output float32 [1, 512].
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Final, Protocol

import numpy as np
import numpy.typing as npt

from worker.face.types import ALIGNED_SIZE, AlignedFace, Embedding, EmbeddingError

MODEL_FILE_NAME: Final = "glintr100.onnx"
# ADR 0001 section 12.2 (checked 2026-10-01). 260,694,151 bytes.
AURAFACE_SHA256: Final = "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60"
MODEL_ID: Final = f"auraface-v1:{AURAFACE_SHA256[:8]}"
EMBEDDING_DIM: Final = 512
MODEL_PATH_ENV: Final = "AURAFACE_MODEL_PATH"


class ModelLoadError(Exception):
    """Model refused or failed to load. Messages are fixed codes: no paths, no bytes."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _NodeArg(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def shape(self) -> Sequence[object]: ...


class OnnxSession(Protocol):
    """The slice of onnxruntime.InferenceSession used here (so tests can fake it)."""

    def get_inputs(self) -> Sequence[_NodeArg]: ...

    def run(
        self, output_names: Sequence[str] | None, input_feed: Mapping[str, npt.NDArray[np.float32]]
    ) -> Sequence[npt.NDArray[np.float32]]: ...


SessionFactory = Callable[[Path], OnnxSession]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _ort_session(path: Path) -> OnnxSession:  # pragma: no cover - needs onnxruntime and the model
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    session: OnnxSession = ort.InferenceSession(
        str(path), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    return session


class AuraFaceEmbedder:
    """`FaceEmbedder` backed by the pinned AuraFace recognition model."""

    def __init__(self, model_path: Path, session_factory: SessionFactory = _ort_session) -> None:
        if model_path.name != MODEL_FILE_NAME:
            raise ModelLoadError("WRONG_MODEL_FILE_NAME")
        try:
            digest = sha256_file(model_path)
        except OSError:
            raise ModelLoadError("MODEL_UNREADABLE") from None
        if digest != AURAFACE_SHA256:
            raise ModelLoadError("MODEL_HASH_MISMATCH")
        try:
            self._session = session_factory(model_path)
            inp = self._session.get_inputs()[0]
        except Exception:
            raise ModelLoadError("MODEL_LOAD_FAILED") from None
        dims = list(inp.shape)[1:]
        if dims != [3, ALIGNED_SIZE, ALIGNED_SIZE]:
            raise ModelLoadError("UNEXPECTED_INPUT_SHAPE")
        self._input_name = inp.name

    @classmethod
    def from_env(cls, session_factory: SessionFactory = _ort_session) -> AuraFaceEmbedder:
        raw = os.environ.get(MODEL_PATH_ENV)
        if not raw:
            raise ModelLoadError("MODEL_PATH_NOT_SET")
        return cls(Path(raw), session_factory)

    @property
    def model_id(self) -> str:
        return MODEL_ID

    def embed(self, aligned: AlignedFace) -> Embedding:
        px = aligned.pixels
        if px.shape != (ALIGNED_SIZE, ALIGNED_SIZE, 3) or px.dtype != np.uint8:
            raise EmbeddingError("BAD_INPUT")
        blob = ((px.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
        outputs = self._session.run(None, {self._input_name: np.ascontiguousarray(blob)})
        out = np.asarray(outputs[0])
        if out.shape != (1, EMBEDDING_DIM) or out.dtype != np.float32:
            raise EmbeddingError("BAD_OUTPUT")
        return Embedding(out[0])


def cosine(a: Embedding, b: Embedding) -> float:
    """Cosine similarity of two embeddings of the same dimension, in [-1, 1]."""
    if a.dim != b.dim:
        raise EmbeddingError("DIM_MISMATCH")
    x, y = a.vector.astype(np.float64), b.vector.astype(np.float64)
    score = float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y)))
    return max(-1.0, min(1.0, score))
