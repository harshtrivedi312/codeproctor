"""models.lock.json and the startup check (ADR 0014 section 7, ADR 0013 section 6, ADR 0001 F-1).

The lock uses the ADR 0013 `files[]` shape. The worker refuses to start on any file under the
models directory that is not in the lock, that is `blocked`, or whose hash differs. A listed
approved or unverified file that is missing only makes `/v1/ready` report not ready.

`blocked` entries may have no hash yet (`models:update` records it); they then block by name only.
A blocked entry that does have a hash also blocks a renamed copy.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

_HEX64: Final = re.compile(r"[0-9a-f]{64}")
_SPDX: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+-]*")
COMPONENTS: Final = frozenset({"FACE_EMBED", "FACE_LANDMARK", "VAD", "NONE"})


class ModelLockError(Exception):
    """Lock unreadable or invalid, or the models directory refused. Fixed code only."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class LockEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    component: str
    source: str
    version: str
    sha256: str | None
    bytes: int | None = Field(ge=1)
    licence: str
    licenceUrl: str | None = None  # noqa: N815 - the lock file's field name
    licenceFile: str | None = None  # noqa: N815
    flag: str | None = None
    status: Literal["approved", "unverified", "blocked"]

    @model_validator(mode="after")
    def _check(self) -> LockEntry:
        if (
            self.name.startswith("/")
            or ".." in Path(self.name).parts
            or Path(self.name).as_posix() != self.name
        ):
            raise ValueError("name must be a normalised relative path")
        if self.status != "blocked" and (self.sha256 is None or self.bytes is None):
            raise ValueError("hash and size are required unless blocked")
        if self.sha256 is not None and not _HEX64.fullmatch(self.sha256):
            raise ValueError("sha256 must be 64 lowercase hex characters")
        if self.component not in COMPONENTS or (self.component == "NONE") != (
            self.status == "blocked"
        ):
            raise ValueError("component must be a known one; NONE only for blocked")
        if self.status == "approved" and not _SPDX.fullmatch(self.licence):
            raise ValueError("approved needs an SPDX licence id")
        if self.status == "approved" and self.licence.lower() == "unverified":
            raise ValueError("approved cannot be unverified")
        if self.status == "unverified" and self.licence != "unverified":
            raise ValueError("unverified needs the literal licence 'unverified'")
        return self


class ModelLock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = Field(alias="schema")
    files: list[LockEntry]

    @model_validator(mode="after")
    def _unique(self) -> ModelLock:
        names = [f.name for f in self.files]
        if len(set(names)) != len(names):
            raise ValueError("duplicate name")
        usable = [f.sha256 for f in self.files if f.status != "blocked"]
        blocked = {f.sha256 for f in self.files if f.status == "blocked" and f.sha256}
        if len(set(usable)) != len(usable) or blocked & set(usable):
            raise ValueError("a hash may belong to one entry, and never to a blocked one")
        return self


@dataclass(frozen=True, slots=True)
class LoadedLock:
    lock: ModelLock
    digest12: str  # first 12 hex characters of the SHA-256 of the file's bytes


def load_lock(path: Path) -> LoadedLock:
    try:
        raw = path.read_bytes()
        lock = ModelLock.model_validate(json.loads(raw))
    except (OSError, ValueError, ValidationError):
        raise ModelLockError("LOCK_INVALID") from None  # no detail: paths and values stay out
    return LoadedLock(lock, hashlib.sha256(raw).hexdigest()[:12])


@dataclass(frozen=True, slots=True)
class ModelCheck:
    ready: bool
    missing: tuple[str, ...]  # lock names of approved or unverified files not on disk
    lock_digest: str
    models: tuple[tuple[str, str], ...]  # (component, name) of files present and verified


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def check_models(loaded: LoadedLock, models_dir: Path) -> ModelCheck:
    """Hash everything under `models_dir` against the lock. Raises ModelLockError (startup
    refusal) on an unlisted file, a blocked file (by name or by hash) or a hash/size mismatch."""
    by_name = {f.name: f for f in loaded.lock.files}
    blocked_hashes = {
        f.sha256 for f in loaded.lock.files if f.status == "blocked" and f.sha256 is not None
    }
    present: set[str] = set()
    if models_dir.is_symlink():
        raise ModelLockError("MODEL_SYMLINK")
    if models_dir.is_dir():
        for path in sorted(models_dir.rglob("*")):
            if path.is_symlink():
                raise ModelLockError("MODEL_SYMLINK")
            if path.is_dir():
                continue
            if not path.is_file():  # FIFO, socket, device
                raise ModelLockError("MODEL_SPECIAL_FILE")
            name = path.relative_to(models_dir).as_posix()
            entry = by_name.get(name)
            if entry is not None and entry.status == "blocked":
                raise ModelLockError("MODEL_BLOCKED")
            if entry is None:
                # Unlisted, but a renamed copy of a blocked file is reported as blocked.
                if _sha256_file(path) in blocked_hashes:
                    raise ModelLockError("MODEL_BLOCKED")
                raise ModelLockError("MODEL_UNLISTED")
            if path.stat().st_size != entry.bytes:  # cheap check first: no hashing of a wrong file
                raise ModelLockError("MODEL_HASH_MISMATCH")
            digest = _sha256_file(path)
            if digest in blocked_hashes:
                raise ModelLockError("MODEL_BLOCKED")
            if digest != entry.sha256:
                raise ModelLockError("MODEL_HASH_MISMATCH")
            present.add(name)
    wanted = [f for f in loaded.lock.files if f.status != "blocked"]
    missing = tuple(f.name for f in wanted if f.name not in present)
    models = tuple((f.component, f.name) for f in wanted if f.name in present)
    return ModelCheck(not missing, missing, loaded.digest12, models)
