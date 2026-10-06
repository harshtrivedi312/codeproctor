"""ADR 0014 section 7 / ADR 0001 F-1: the model lock and the startup check (FR-403)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from worker import modellock
from worker.modellock import ModelLockError, check_models, load_lock

GLINT_SHA = "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60"


def entry(
    name: str, data: bytes | None, status: str = "approved", **kw: object
) -> dict[str, object]:
    return {
        "name": name,
        "component": "FACE_EMBED",
        "source": "https://example.test/m",
        "version": "v1",
        "sha256": hashlib.sha256(data).hexdigest() if data is not None else None,
        "bytes": len(data) if data is not None else None,
        "licence": "Apache-2.0",
        "licenceUrl": None,
        "flag": None,
        "status": status,
        **kw,
    }


def write_lock(tmp_path: Path, files: list[dict[str, object]]) -> Path:
    p = tmp_path / "models.lock.json"
    p.write_text(json.dumps({"schema": 1, "files": files}))
    return p


def put(models: Path, name: str, data: bytes) -> None:
    f = models / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)


def test_committed_lock_is_valid_pins_auraface_and_blocks_the_four_insightface_files() -> None:
    loaded = load_lock(Path(__file__).resolve().parents[1] / "models.lock.json")
    by = {f.name: f for f in loaded.lock.files}
    assert by["auraface-v1/glintr100.onnx"].sha256 == GLINT_SHA
    assert by["auraface-v1/glintr100.onnx"].bytes == 260_694_151
    assert by["auraface-v1/glintr100.onnx"].status == "unverified"
    blocked = {n for n, f in by.items() if f.status == "blocked"}
    assert blocked == {
        "auraface-v1/scrfd_10g_bnkps.onnx",
        "auraface-v1/2d106det.onnx",
        "auraface-v1/1k3d68.onnx",
        "auraface-v1/genderage.onnx",
    }
    assert len(loaded.digest12) == 12


def test_all_listed_files_present_and_matching_is_ready(tmp_path: Path) -> None:
    put(tmp_path / "m", "a/one.onnx", b"one")
    lock = load_lock(write_lock(tmp_path, [entry("a/one.onnx", b"one")]))
    chk = check_models(lock, tmp_path / "m")
    assert chk.ready and chk.missing == () and chk.models == (("FACE_EMBED", "a/one.onnx"),)
    assert chk.lock_digest == lock.digest12


def test_missing_approved_file_is_not_ready_but_does_not_refuse_startup(tmp_path: Path) -> None:
    (tmp_path / "m").mkdir()
    lock = load_lock(write_lock(tmp_path, [entry("a/one.onnx", b"one")]))
    chk = check_models(lock, tmp_path / "m")
    assert not chk.ready and chk.missing == ("a/one.onnx",)
    assert not check_models(lock, tmp_path / "does-not-exist").ready


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("unlisted", "MODEL_UNLISTED"),
        ("blocked_name", "MODEL_BLOCKED"),
        ("blocked_hash_renamed", "MODEL_BLOCKED"),
        ("mismatch", "MODEL_HASH_MISMATCH"),
        ("symlink", "MODEL_SYMLINK"),
    ],
)
def test_f1_startup_refuses_unlisted_blocked_renamed_mismatched_and_symlinked_files(
    tmp_path: Path, setup: str, code: str
) -> None:
    m = tmp_path / "m"
    files = [entry("ok.onnx", b"ok")]
    put(m, "ok.onnx", b"ok")
    if setup == "unlisted":
        put(m, "sneaky.onnx", b"x")
    elif setup == "blocked_name":
        files.append(entry("bad.onnx", None, "blocked"))
        put(m, "bad.onnx", b"anything")
    elif setup == "blocked_hash_renamed":
        files.append(entry("bad.onnx", b"insight", "blocked"))
        put(m, "renamed.onnx", b"insight")
    elif setup == "mismatch":
        put(m, "ok.onnx", b"tampered")
    elif setup == "symlink":
        (m / "link.onnx").symlink_to(m / "ok.onnx")
    lock = load_lock(write_lock(tmp_path, files))
    with pytest.raises(ModelLockError) as ei:
        check_models(lock, m)
    assert ei.value.code == code


@pytest.mark.parametrize(
    "bad",
    [
        {"schema": 2, "files": []},
        {"schema": 1, "files": [], "extra": 1},
        {"schema": 1, "files": [entry("a", b"x"), entry("a", b"y")]},
        {"schema": 1, "files": [entry("../a", b"x")]},
        {"schema": 1, "files": [entry("/abs", b"x")]},
        {"schema": 1, "files": [{**entry("a", b"x"), "sha256": None}]},
        {"schema": 1, "files": [{**entry("a", b"x"), "sha256": "ABC"}]},
        {"schema": 1, "files": [{**entry("a", b"x"), "status": "maybe"}]},
    ],
)
def test_invalid_lock_is_refused_without_detail(tmp_path: Path, bad: dict[str, object]) -> None:
    p = tmp_path / "l.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ModelLockError) as ei:
        load_lock(p)
    assert ei.value.code == "LOCK_INVALID" and str(tmp_path) not in str(ei.value)
    with pytest.raises(ModelLockError):
        load_lock(tmp_path / "missing.json")


def test_digest_changes_with_the_file_bytes(tmp_path: Path) -> None:
    a = load_lock(write_lock(tmp_path, [entry("a", b"x")]))
    b = load_lock(write_lock(tmp_path, [entry("a", b"y")]))
    assert a.digest12 != b.digest12 and modellock.__doc__
