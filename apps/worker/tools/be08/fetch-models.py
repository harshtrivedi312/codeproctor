#!/usr/bin/env python3
"""Fetch the pinned face models into ~/.cache/codeproctor/models and verify them (C-10, C-22).

    python3 apps/worker/tools/be08/fetch-models.py              # report what is present, download nothing
    python3 apps/worker/tools/be08/fetch-models.py --download   # fetch what is missing

Only files listed in apps/worker/models.lock.json with a component of FACE_EMBED or FACE_LANDMARK
are ever considered. Every file is checked against the lock's SHA-256 and byte size before it is
moved into place; a mismatch deletes the download and fails. A file whose lock status is not
"approved" (the licence gate, ADR 0001 section 12) is refused unless the person running this
passes --accept-unverified-licence for that run. Standard library only; reads no credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

LOCK = Path(__file__).resolve().parents[2] / "models.lock.json"
FACE_COMPONENTS = {"FACE_EMBED", "FACE_LANDMARK"}
# Direct download locations for the pinned files. The digest in the lock is the authority:
# a different file at these URLs fails the check and is deleted.
SOURCES = {
    "auraface-v1/glintr100.onnx": "https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx",
    "mediapipe/face_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
        "face_landmarker/float16/1/face_landmarker.task"
    ),
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ok(path: Path, entry: dict[str, object]) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == entry["bytes"]
        and sha256(path) == entry["sha256"]
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--download", action="store_true", help="fetch missing or wrong files")
    ap.add_argument("--accept-unverified-licence", action="store_true")
    ap.add_argument("--dir", default=os.path.expanduser("~/.cache/codeproctor/models"))
    args = ap.parse_args()
    root = Path(args.dir)
    entries = [e for e in json.loads(LOCK.read_text())["files"] if e["component"] in FACE_COMPONENTS]
    failed = False
    for e in entries:
        name = e["name"]
        dest = root / name
        if ok(dest, e):
            print(f"ok       {name}")
            continue
        flat = root / Path(name).name  # the first download went in flat; the worker wants the lock's layout
        if flat != dest and ok(flat, e):
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.link(flat, dest)  # a hard link keeps one copy; a symlink would be refused
            flat.unlink()  # an unlisted file in the models directory stops the worker at startup
            print(f"moved    {name} (from {flat.name})")
            continue
        if not args.download:
            print(f"MISSING  {name} (run with --download)")
            failed = True
            continue
        if e["status"] != "approved" and not args.accept_unverified_licence:
            print(f"REFUSED  {name}: licence status is {e['status']!r} ({e['flag']}); see {e['licenceUrl']}")
            failed = True
            continue
        url = SOURCES.get(name)
        if url is None:
            print(f"NO SOURCE {name}")
            failed = True
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False, suffix=".part") as tmp:
            tmp_path = Path(tmp.name)
            with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 (https, fixed URL)
                for chunk in iter(lambda: resp.read(1 << 20), b""):
                    tmp.write(chunk)
        if ok(tmp_path, e):
            tmp_path.replace(dest)
            print(f"fetched  {name}")
        else:
            tmp_path.unlink()
            print(f"BAD DIGEST {name}: download deleted")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
