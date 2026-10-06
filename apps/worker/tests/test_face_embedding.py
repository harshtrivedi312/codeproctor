from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest

from worker.face import embedding as emb
from worker.face.embedding import AURAFACE_SHA256, MODEL_ID, AuraFaceEmbedder, cosine
from worker.face.modelfile import ModelLoadError
from worker.face.types import AlignedFace, Embedding, EmbeddingError


class _Arg:
    def __init__(self, name: str, shape: Sequence[object]) -> None:
        self.name = name
        self.shape = shape


class FakeSession:
    def __init__(
        self,
        shape: Sequence[object] = ("N", 3, 112, 112),
        out: npt.NDArray[np.float32] | None = None,
    ) -> None:
        self._shape = shape
        self._out = out if out is not None else np.arange(1, 513, dtype=np.float32)[None]
        self.feeds: list[Mapping[str, npt.NDArray[np.float32]]] = []

    def get_inputs(self) -> Sequence[_Arg]:
        return [_Arg("input.1", self._shape)]

    def run(
        self, output_names: Sequence[str] | None, input_feed: Mapping[str, npt.NDArray[np.float32]]
    ) -> Sequence[npt.NDArray[np.float32]]:
        self.feeds.append(input_feed)
        return [self._out]


@pytest.fixture
def model_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake 'glintr100.onnx' whose digest is installed as the pin for this test only."""
    p = tmp_path / "glintr100.onnx"
    p.write_bytes(b"synthetic placeholder, not a model")
    monkeypatch.setattr(emb, "AURAFACE_SHA256", hashlib.sha256(p.read_bytes()).hexdigest())
    return p


def aligned() -> AlignedFace:
    return AlignedFace(np.full((112, 112, 3), 127, dtype=np.uint8))


def test_fr403_model_id_and_pin_match_adr_0004() -> None:
    assert MODEL_ID == "auraface-v1:a7933ea5"
    assert AURAFACE_SHA256.startswith("a7933ea5") and len(AURAFACE_SHA256) == 64


def test_fr403_hash_mismatch_is_refused(tmp_path: Path) -> None:
    p = tmp_path / "glintr100.onnx"
    p.write_bytes(b"not the pinned model")
    with pytest.raises(ModelLoadError) as e:
        AuraFaceEmbedder(p, lambda _b: FakeSession())
    assert e.value.code == "MODEL_HASH_MISMATCH"


@pytest.mark.parametrize(
    "name", ["scrfd_10g_bnkps.onnx", "2d106det.onnx", "model.onnx", "glintr100.onnx.bak"]
)
def test_fr403_f1_any_other_file_name_is_refused_even_with_valid_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    p = tmp_path / name
    p.write_bytes(b"x")
    monkeypatch.setattr(emb, "AURAFACE_SHA256", hashlib.sha256(b"x").hexdigest())
    with pytest.raises(ModelLoadError) as e:
        AuraFaceEmbedder(p, lambda _b: FakeSession())
    assert e.value.code == "WRONG_MODEL_FILE_NAME"


def test_fr403_missing_file_and_unset_env_are_load_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ModelLoadError, match="MODEL_UNREADABLE"):
        AuraFaceEmbedder(tmp_path / "glintr100.onnx", lambda _b: FakeSession())
    monkeypatch.delenv("AURAFACE_MODEL_PATH", raising=False)
    with pytest.raises(ModelLoadError, match="MODEL_PATH_NOT_SET"):
        AuraFaceEmbedder.from_env()


def test_fr403_from_env_loads_a_verified_model(
    model_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AURAFACE_MODEL_PATH", str(model_file))
    assert AuraFaceEmbedder.from_env(lambda _b: FakeSession()).model_id == MODEL_ID


def test_fr403_session_failure_and_wrong_input_shape_are_load_errors(model_file: Path) -> None:
    def boom(_b: bytes) -> FakeSession:
        raise RuntimeError("secret path /x/y")

    with pytest.raises(ModelLoadError) as e:
        AuraFaceEmbedder(model_file, boom)
    assert e.value.code == "MODEL_LOAD_FAILED" and "secret" not in str(e.value)
    with pytest.raises(ModelLoadError, match="UNEXPECTED_INPUT_SHAPE"):
        AuraFaceEmbedder(model_file, lambda _b: FakeSession(shape=("N", 3, 64, 64)))


def test_fr403_embed_preprocesses_rgb_to_nchw_float32_in_range(model_file: Path) -> None:
    session = FakeSession()
    e = AuraFaceEmbedder(model_file, lambda _b: session)
    out = e.embed(aligned())
    blob = session.feeds[0]["input.1"]
    assert blob.shape == (1, 3, 112, 112) and blob.dtype == np.float32
    assert np.allclose(blob, (127 - 127.5) / 127.5)
    assert out.dim == 512


def test_fr403_embed_rejects_bad_input_and_bad_model_output(model_file: Path) -> None:
    e = AuraFaceEmbedder(model_file, lambda _b: FakeSession())
    with pytest.raises(EmbeddingError, match="BAD_INPUT"):
        e.embed(AlignedFace(np.zeros((64, 64, 3), dtype=np.uint8)))
    with pytest.raises(EmbeddingError, match="BAD_INPUT"):
        e.embed(AlignedFace(np.zeros((112, 112, 3), dtype=np.float32)))
    wrong_shape = AuraFaceEmbedder(
        model_file, lambda _b: FakeSession(out=np.ones((1, 128), np.float32))
    )
    with pytest.raises(EmbeddingError, match="BAD_OUTPUT"):
        wrong_shape.embed(aligned())
    wrong_dtype = AuraFaceEmbedder(
        model_file, lambda _b: FakeSession(out=np.ones((1, 512), np.float64))
    )
    with pytest.raises(EmbeddingError, match="BAD_OUTPUT"):
        wrong_dtype.embed(aligned())


def test_fr403_model_nan_and_zero_outputs_are_embedding_errors(model_file: Path) -> None:
    nan = np.full((1, 512), np.nan, dtype=np.float32)
    zero = np.zeros((1, 512), dtype=np.float32)
    with pytest.raises(EmbeddingError, match="NON_FINITE"):
        AuraFaceEmbedder(model_file, lambda _b: FakeSession(out=nan)).embed(aligned())
    with pytest.raises(EmbeddingError, match="ZERO_NORM"):
        AuraFaceEmbedder(model_file, lambda _b: FakeSession(out=zero)).embed(aligned())


def test_fr403_real_model_runs_when_provided(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt-in (owner approval P-07 for downloading is parked): set AURAFACE_MODEL_PATH."""
    import os

    if not os.environ.get("AURAFACE_MODEL_PATH"):
        pytest.skip("Set AURAFACE_MODEL_PATH to the pinned glintr100.onnx to run (manual).")
    e = AuraFaceEmbedder.from_env()
    assert e.embed(aligned()).dim == 512


# ---------- cosine ----------


def v(*xs: float) -> Embedding:
    return Embedding(np.array(xs, dtype=np.float32))


def test_fr403_cosine_identical_opposite_orthogonal_and_scale_invariant() -> None:
    assert cosine(v(1, 2, 3), v(1, 2, 3)) == pytest.approx(1.0)
    assert cosine(v(1, 2, 3), v(-1, -2, -3)) == pytest.approx(-1.0)
    assert cosine(v(1, 0), v(0, 1)) == pytest.approx(0.0)
    assert cosine(v(1, 2, 3), v(10, 20, 30)) == pytest.approx(1.0)


def test_fr403_cosine_dimension_mismatch_is_an_error() -> None:
    with pytest.raises(EmbeddingError, match="DIM_MISMATCH"):
        cosine(v(1, 2), v(1, 2, 3))


@pytest.mark.parametrize(
    ("vec", "code"),
    [
        (np.array([1, np.nan], dtype=np.float32), "NON_FINITE"),
        (np.array([1, np.inf], dtype=np.float32), "NON_FINITE"),
        (np.zeros(4, dtype=np.float32), "ZERO_NORM"),
        (np.array([1, 2], dtype=np.float64), "SHAPE_OR_DTYPE"),
        (np.ones((2, 2), dtype=np.float32), "SHAPE_OR_DTYPE"),
        (np.array([], dtype=np.float32), "SHAPE_OR_DTYPE"),
    ],
)
def test_fr403_embedding_rejects_nan_inf_zero_norm_and_bad_shape_or_dtype(
    vec: npt.NDArray[np.generic], code: str
) -> None:
    with pytest.raises(EmbeddingError, match=code):
        Embedding(vec)  # type: ignore[arg-type]


def test_fr403_embedding_is_immutable_and_independent_of_the_source_array() -> None:
    src = np.array([1, 2, 3], dtype=np.float32)
    e = Embedding(src)
    src[0] = 99
    assert e.vector[0] == 1
    with pytest.raises(ValueError):
        e.vector[0] = 5


def test_fr403_s1_session_factory_is_never_called_on_hash_mismatch_or_wrong_name(
    tmp_path: Path,
) -> None:
    calls: list[bytes] = []

    def factory(model: bytes) -> FakeSession:
        calls.append(model)
        return FakeSession()

    bad = tmp_path / "glintr100.onnx"
    bad.write_bytes(b"tampered")
    with pytest.raises(ModelLoadError, match="MODEL_HASH_MISMATCH"):
        AuraFaceEmbedder(bad, factory)
    other = tmp_path / "scrfd_10g_bnkps.onnx"
    other.write_bytes(b"x")
    with pytest.raises(ModelLoadError, match="WRONG_MODEL_FILE_NAME"):
        AuraFaceEmbedder(other, factory)
    assert calls == []


def test_fr403_s1_the_verified_bytes_are_the_bytes_that_run_file_is_read_once(
    model_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = model_file.read_bytes()
    reads = {"n": 0}
    real = Path.read_bytes

    def counting(self: Path) -> bytes:
        reads["n"] += 1
        data = real(self)
        self.write_bytes(b"swapped after the read")  # an attacker replaces the file mid-load
        return data

    monkeypatch.setattr(Path, "read_bytes", counting)
    seen: list[bytes] = []

    def factory(model: bytes) -> FakeSession:
        seen.append(model)
        return FakeSession()

    AuraFaceEmbedder(model_file, factory)
    assert reads["n"] == 1 and seen == [original]
