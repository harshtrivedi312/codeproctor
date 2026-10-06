"""Crop one volunteer ID photo to the face and delete the original (form section 2, C-11).

    python -m tools.int01.crop_id --src ~/tuning/incoming/id.jpg --dest ~/tuning/out/v-0001.png

Uses the worker's MediaPipe detector (`FACE_LANDMARKER_MODEL_PATH`, which must point into
~/.cache/codeproctor/models, C-22) and `intake.intake_id_photo`. The kept image is the face box
plus a thin margin (PNG, 0600, no metadata), and the original is always deleted, even when no
single face is found. Prints only a fixed code, never a path.

**The box proportions are NOT verified on real ID photos.** A crop may include print near the
portrait. Look at every crop: if any text (a name, a date of birth, a number) is visible, delete
the crop and ask the volunteer for a new photo on the covered template (the original is already
gone). Needs the landmarker model, which is not downloaded until the owner approves P-13; tests
use a fake detector.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from tools.int01.intake import FaceLocator, IntakeError, intake_id_photo
from tools.int01.locator import LOCATOR_MARGIN, DetectorLocator
from tools.int01.safety import model_path_allowed

MODELS_DIR = Path("~/.cache/codeproctor/models").expanduser()


def _check_landmarker_location() -> None:
    if not model_path_allowed(os.environ.get("FACE_LANDMARKER_MODEL_PATH", ""), MODELS_DIR):
        raise SystemExit("FACE_LANDMARKER_MODEL_PATH must point into ~/.cache/codeproctor/models")


def run(src: Path, dest: Path, locator: FaceLocator) -> int:
    try:
        intake_id_photo(src, dest, locator, LOCATOR_MARGIN)
    except IntakeError as e:  # a fixed code: NO_FACE, MULTIPLE_FACES, UNREADABLE, ...
        print(f"not kept: {e.code}", file=sys.stderr)
        if e.code == "DELETE_FAILED":
            print("the original may remain: check the incoming folder", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted: check the incoming folder", file=sys.stderr)
        return 130
    except Exception:  # noqa: BLE001 - last resort: never a traceback with paths or code lines
        print("not kept: UNEXPECTED", file=sys.stderr)
        print("the original may remain: check the incoming folder", file=sys.stderr)
        return 2
    print("kept: portrait only; original deleted")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--src", type=Path, required=True)
    ap.add_argument("--dest", type=Path, required=True)
    args = ap.parse_args(argv)
    _check_landmarker_location()
    from worker.face.detector import MediaPipeDetector
    from worker.face.modelfile import ModelLoadError

    try:
        locator = DetectorLocator(MediaPipeDetector.from_config())
    except ModelLoadError as e:
        print(f"face model not usable: {e.code}", file=sys.stderr)
        return 2
    return run(args.src, args.dest, locator)


if __name__ == "__main__":
    raise SystemExit(main())
