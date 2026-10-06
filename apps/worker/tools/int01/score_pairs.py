"""Image pairs to scores for INT-01 (offline; FR-403, D-05, C-11, C-22).

    python -m tools.int01.score_pairs --manifest ~/tuning/pairs.csv --out ~/tuning/scores.csv

The manifest (outside the repository) has the columns `subject,kind,reference,probe`: `reference`
is the volunteer's cropped ID portrait, `probe` a selfie; `kind` is genuine (same person) or
impostor (the reference belongs to someone else); `subject` is the probe's random volunteer code
(letters, digits and dashes). Relative paths are resolved against the manifest's folder, and
images must stay inside it unless `--allow-outside-manifest-dir` is given.

Each pair goes through the worker's own `FaceMatcher.match`, the same decision flow production
uses, with the pinned AuraFace model. Embeddings live in memory for one comparison and are never
written: the output holds scores only (0600). A pair that cannot be scored gets status
`unscored`. An unscored genuine pair would go to manual review in production, so it is stored
as -1.0 and counts as a false non-match; an unscored impostor pair cannot be a false match and
is left out of the FMR. The evaluator reports both counts. A missing or unreadable image file is
different (usually a typo): the run stops unless `--allow-missing` is given. The tool refuses
paths inside a git tree and model files outside ~/.cache/codeproctor/models (C-22), prints only
fixed text (never a path or a subject code), and never downloads anything.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import stat
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from tools.int01.safety import inside_git_tree
from worker.face.matcher import FaceMatcher
from worker.face.types import ReviewReason

MODELS_DIR: Final = Path("~/.cache/codeproctor/models").expanduser()
UNSCORED_GENUINE: Final = -1.0
MAX_IMAGE_FILE_BYTES: Final = 10 * 1024 * 1024
_COLUMNS: Final = {"subject", "kind", "reference", "probe"}
_SUBJECT: Final = re.compile(r"[A-Za-z0-9-]{1,64}")  # no leading "=", "+", "@": spreadsheet-safe


class ScoringError(Exception):
    """Fixed message only: no paths, no subject codes."""


@dataclass(frozen=True, slots=True)
class PairSpec:
    subject: str
    kind: str
    reference: Path
    probe: Path


@dataclass(frozen=True, slots=True)
class ScoringSummary:
    scored: int
    genuine_unscored: int  # stored as -1.0 (they would go to manual review)
    impostor_unscored: int  # left out of the FMR
    unreadable: int  # image files that could not be read at all (counted among the unscored)


Row = tuple[str, str, float | None, bool]  # subject, kind, score (None: none), unscored?


def load_manifest(path: Path, *, allow_outside: bool = False) -> list[PairSpec]:
    if inside_git_tree(path):
        raise ScoringError("the manifest must be stored outside the repository")
    base = path.resolve().parent
    specs: list[PairSpec] = []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if set(reader.fieldnames or ()) != _COLUMNS:
            raise ScoringError("manifest columns must be exactly: subject,kind,reference,probe")
        for row in reader:
            subject = (row["subject"] or "").strip()
            if not _SUBJECT.fullmatch(subject) or row["kind"] not in ("genuine", "impostor"):
                raise ScoringError(
                    "each row needs a plain subject code and kind genuine or impostor"
                )
            ref, probe = (base / row["reference"]).resolve(), (base / row["probe"]).resolve()
            if inside_git_tree(ref) or inside_git_tree(probe):
                raise ScoringError("images must be stored outside the repository")
            if not allow_outside and not (ref.is_relative_to(base) and probe.is_relative_to(base)):
                raise ScoringError("images must be inside the manifest's folder")
            specs.append(PairSpec(subject, row["kind"], ref, probe))
    if not specs:
        raise ScoringError("the manifest has no rows")
    return specs


def _read_image(path: Path) -> bytes:
    if path.stat().st_size > MAX_IMAGE_FILE_BYTES:  # before reading a huge file into memory
        raise OSError("too large")
    return path.read_bytes()


def score_pairs(
    specs: Sequence[PairSpec], matcher: FaceMatcher
) -> tuple[list[Row], ScoringSummary]:
    rows: list[Row] = []
    genuine_unscored = impostor_unscored = unreadable = 0
    for spec in specs:
        score: float | None = None
        try:
            result = matcher.match(
                _read_image(spec.reference),
                _read_image(spec.probe),
                liveness_confirmed=True,  # a client signal, not part of tuning (see the report)
            )
            if result.reason in (None, ReviewReason.BELOW_THRESHOLD):
                score = result.score
        except OSError:
            unreadable += 1  # the message never carries the path
        if spec.kind == "genuine":
            if score is None:
                genuine_unscored += 1
            value = UNSCORED_GENUINE if score is None else score
            rows.append((spec.subject, "genuine", value, score is None))
        elif score is None:
            impostor_unscored += 1
            rows.append((spec.subject, "impostor", None, True))
        else:
            rows.append((spec.subject, "impostor", score, False))
    scored = len(rows) - genuine_unscored - impostor_unscored
    return rows, ScoringSummary(scored, genuine_unscored, impostor_unscored, unreadable)


def write_scores(path: Path, rows: Sequence[Row]) -> None:
    """0600 even over an existing file; refuses a symlink and anything that is not a plain file."""
    if inside_git_tree(path):
        raise ScoringError("the scores file must be stored outside the repository")
    # O_NONBLOCK: opening a FIFO with no reader must fail, not hang the tool.
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags, 0o600)  # no O_TRUNC yet: check what it is before touching it
    except OSError:
        raise ScoringError("the scores file cannot be written") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ScoringError("the scores file must be a plain file")
        os.fchmod(fd, 0o600)
        os.ftruncate(fd, 0)
        fh = os.fdopen(fd, "w", newline="", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise
    with fh:
        writer = csv.writer(fh)
        writer.writerow(["subject", "kind", "score", "status"])
        for subject, kind, score, unscored in rows:
            shown = "" if score is None else f"{score:.6f}"
            writer.writerow([subject, kind, shown, "unscored" if unscored else "scored"])


def check_model_location(environ: Mapping[str, str] | None = None) -> None:
    """C-22: models are used only from ~/.cache/codeproctor/models, never from git."""
    env = os.environ if environ is None else environ
    if MODELS_DIR.is_symlink():
        raise ScoringError("the models folder must not be a symlink")
    folder = MODELS_DIR.resolve()
    for var in ("AURAFACE_MODEL_PATH", "FACE_LANDMARKER_MODEL_PATH"):
        raw = env.get(var, "")
        if not raw and var == "FACE_LANDMARKER_MODEL_PATH":
            continue  # absent: the matcher build reports it
        target = Path(raw).expanduser().resolve() if raw else None
        if target is None or not target.is_relative_to(folder) or inside_git_tree(target):
            raise ScoringError(f"{var} must point into ~/.cache/codeproctor/models")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--allow-missing", action="store_true", help="treat unreadable images as unscored"
    )
    ap.add_argument("--allow-outside-manifest-dir", action="store_true")
    args = ap.parse_args(argv)
    try:
        check_model_location()
        specs = load_manifest(args.manifest, allow_outside=args.allow_outside_manifest_dir)
        from worker.face.factory import build_face_matcher
        from worker.face.modelfile import ModelLoadError

        try:
            matcher = build_face_matcher()
        except ModelLoadError as e:  # the code is fixed text (for example MODEL_PATH_NOT_SET)
            raise ScoringError(f"face model not usable: {e.code}") from None
        rows, summary = score_pairs(specs, matcher)
        if summary.unreadable and not args.allow_missing:
            print(
                f"error: {summary.unreadable} image file(s) could not be read; nothing written "
                "(fix the manifest, or use --allow-missing)",
                file=sys.stderr,
            )
            return 2
        write_scores(args.out, rows)
    except ScoringError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError, csv.Error, UnicodeError, ValueError):
        # Paths and cell values can hold volunteer codes: say what failed, never with what.
        print("error: an input or output file could not be read or written", file=sys.stderr)
        return 2
    cfg = matcher.config
    print(  # fixed-format counts and the settings that decide which pairs are unscorable
        f"scored: {summary.scored}; genuine unscored (stored as -1.0): "
        f"{summary.genuine_unscored}; impostor unscored (left out of FMR): "
        f"{summary.impostor_unscored}; unreadable files: {summary.unreadable}; "
        f"min detection confidence {cfg.min_detection_confidence}, "
        f"ID secondary face ratio {cfg.id_secondary_face_ratio}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
