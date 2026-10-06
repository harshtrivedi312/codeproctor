"""Image pairs to scores for INT-01 (offline; FR-403, D-05, C-11, C-22).

    python -m tools.int01.score_pairs --manifest ~/tuning/pairs.csv --out ~/tuning/scores.csv

The manifest (outside the repository) has the columns `subject,kind,reference,probe`: `reference`
is the volunteer's cropped ID portrait, `probe` a selfie; `kind` is genuine (same person) or
impostor (the reference belongs to someone else); `subject` is the probe's random volunteer code.
Relative paths are resolved against the manifest's folder.

Each pair goes through the worker's own `FaceMatcher.match`, the same decision flow production
uses, with the pinned AuraFace model. Embeddings live in memory for one comparison and are never
written: the output holds scores only. A genuine pair that cannot be scored (no face, a model
error) would go to manual review in production, so it is recorded as score -1.0 and counts as a
false non-match; an impostor pair that cannot be scored cannot be a false match and is only
counted. The tool refuses paths inside a git tree, a model outside ~/.cache/codeproctor/models
(C-22), and never downloads anything.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from tools.int01.safety import inside_git_tree
from worker.face.matcher import FaceMatcher
from worker.face.types import FaceDecision, ReviewReason

MODELS_DIR: Final = Path("~/.cache/codeproctor/models").expanduser()
UNSCORED_GENUINE: Final = -1.0
_COLUMNS: Final = {"subject", "kind", "reference", "probe"}


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
    genuine_unscored: int  # recorded as -1.0 (they would go to manual review)
    impostor_unscored: int  # dropped (they cannot be false matches)


def load_manifest(path: Path) -> list[PairSpec]:
    if inside_git_tree(path):
        raise ScoringError("the manifest must be stored outside the repository")
    base = path.resolve().parent
    specs: list[PairSpec] = []
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh)
        if set(reader.fieldnames or ()) != _COLUMNS:
            raise ScoringError("manifest columns must be exactly: subject,kind,reference,probe")
        for row in reader:
            subject = (row["subject"] or "").strip()
            if not subject or row["kind"] not in ("genuine", "impostor"):
                raise ScoringError("each row needs a subject and kind genuine or impostor")
            ref, probe = (base / row["reference"]).resolve(), (base / row["probe"]).resolve()
            if inside_git_tree(ref) or inside_git_tree(probe):
                raise ScoringError("images must be stored outside the repository")
            specs.append(PairSpec(subject, row["kind"], ref, probe))
    if not specs:
        raise ScoringError("the manifest has no rows")
    return specs


def score_pairs(
    specs: Sequence[PairSpec], matcher: FaceMatcher
) -> tuple[list[tuple[str, str, float]], ScoringSummary]:
    rows: list[tuple[str, str, float]] = []
    genuine_unscored = impostor_unscored = 0
    for spec in specs:
        score: float | None = None
        try:
            result = matcher.match(
                spec.reference.read_bytes(),
                spec.probe.read_bytes(),
                liveness_confirmed=True,  # liveness is a client signal, not part of tuning
            )
            if result.score is not None and result.reason in (None, ReviewReason.BELOW_THRESHOLD):
                score = result.score
            elif result.decision is FaceDecision.MATCH and result.score is not None:
                score = result.score
        except OSError:
            score = None  # unreadable file: unscored, and the message never carries the path
        if score is None:
            if spec.kind == "genuine":
                genuine_unscored += 1
                rows.append((spec.subject, "genuine", UNSCORED_GENUINE))
            else:
                impostor_unscored += 1
        else:
            rows.append((spec.subject, spec.kind, score))
    return rows, ScoringSummary(len(rows) - genuine_unscored, genuine_unscored, impostor_unscored)


def write_scores(path: Path, rows: Sequence[tuple[str, str, float]]) -> None:
    if inside_git_tree(path):
        raise ScoringError("the scores file must be stored outside the repository")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["subject", "kind", "score"])
        writer.writerows((s, k, f"{v:.6f}") for s, k, v in rows)


def check_model_location(environ: dict[str, str] | os._Environ[str] | None = None) -> None:
    """C-22: the model is used only from ~/.cache/codeproctor/models."""
    env = os.environ if environ is None else environ
    raw = env.get("AURAFACE_MODEL_PATH", "")
    if not raw or not Path(raw).expanduser().resolve().is_relative_to(MODELS_DIR.resolve()):
        raise ScoringError("AURAFACE_MODEL_PATH must point into ~/.cache/codeproctor/models")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    try:
        check_model_location()
        specs = load_manifest(args.manifest)
        from worker.face.factory import build_face_matcher
        from worker.face.modelfile import ModelLoadError

        try:
            matcher = build_face_matcher()
        except ModelLoadError as e:  # the code is fixed text (for example MODEL_PATH_NOT_SET)
            raise ScoringError(f"face model not usable: {e.code}") from None
        rows, summary = score_pairs(specs, matcher)
        write_scores(args.out, rows)
    except ScoringError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(  # fixed-format counts only
        f"scored: {summary.scored}; genuine unscored (recorded as -1.0): "
        f"{summary.genuine_unscored}; impostor unscored (dropped): {summary.impostor_unscored}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
