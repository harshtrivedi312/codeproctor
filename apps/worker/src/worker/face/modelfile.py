"""Verified model file loading (ADR 0001 section 12.2, F-1).

The file is read ONCE into memory, the digest is computed over those bytes, and the same bytes are
handed to the runtime, so a file swapped on disk after the check cannot be the one that runs.
"""

from __future__ import annotations

import hashlib
from pathlib import Path


class ModelLoadError(Exception):
    """Model refused or failed to load. Messages are fixed codes: no paths, no bytes."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def read_verified(path: Path, expected_name: str, expected_sha256: str) -> bytes:
    """Return the file's bytes if its name and SHA-256 match the pin; raise ModelLoadError."""
    if path.name != expected_name:
        raise ModelLoadError("WRONG_MODEL_FILE_NAME")
    try:
        data = path.read_bytes()
    except OSError:
        raise ModelLoadError("MODEL_UNREADABLE") from None
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ModelLoadError("MODEL_HASH_MISMATCH")
    return data
