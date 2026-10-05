"""Offline evaluation: scores in, report out.

    python -m tools.int01.evaluate --synthetic --out /path/outside/repo/report.md
    python -m tools.int01.evaluate --scores scores.csv [--demographics demo.json] --out report.md

scores.csv columns: subject,kind,score  (kind is genuine or impostor; subject is a random code).
demographics.json: {"<subject>": {"<dimension>": "<value>"}}, kept apart from the images and
outside the repository. The tool refuses to read demographics or scores from inside a git
working tree, so they cannot be committed by accident.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections.abc import Sequence
from pathlib import Path

from tools.int01 import groups, metrics, report, synthetic


def inside_git_tree(path: Path) -> bool:
    return any((p / ".git").exists() for p in [path.resolve(), *path.resolve().parents])


def load_scores(path: Path) -> list[groups.ScoredPair]:
    if inside_git_tree(path):
        raise ValueError("scores must be stored outside the repository")
    pairs: list[groups.ScoredPair] = []
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if row["kind"] not in ("genuine", "impostor"):
                raise ValueError("kind must be genuine or impostor")
            pairs.append(groups.ScoredPair(row["subject"], row["kind"], float(row["score"])))
    return pairs


def load_demographics(path: Path) -> dict[str, dict[str, str]]:
    if inside_git_tree(path):
        raise ValueError("demographics must be stored outside the repository")
    data = json.loads(path.read_text())
    return {str(k): {str(a): str(b) for a, b in v.items()} for k, v in data.items()}


def run(
    pairs: Sequence[groups.ScoredPair],
    demographics: dict[str, dict[str, str]],
    target_fmr: float,
    synthetic_data: bool,
    data_label: str,
) -> str:
    g = [p.score for p in pairs if p.kind == "genuine"]
    i = [p.score for p in pairs if p.kind == "impostor"]
    points = metrics.sweep(g, i, metrics.default_thresholds())
    rec = metrics.recommend(points, target_fmr)
    grp = (
        groups.group_report(pairs, demographics, rec.point.threshold)
        if rec.point is not None and demographics
        else []
    )
    return report.render(
        data_label=data_label,
        n_volunteers=len({p.subject for p in pairs}),
        points=[p for p in points if round(p.threshold * 100) % 5 == 0],
        rec=rec,
        groups=grp,
        synthetic=synthetic_data,
    )


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--synthetic", action="store_true")
    src.add_argument("--scores", type=Path)
    ap.add_argument("--demographics", type=Path)
    ap.add_argument("--target-fmr", type=float, default=0.001)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    if args.synthetic:
        pairs, demo = synthetic.synthetic_pairs()
        label = "synthetic scores (no real people)"
    else:
        pairs = load_scores(args.scores)
        demo = load_demographics(args.demographics) if args.demographics else {}
        label = "volunteer tuning set (scores only)"
    args.out.write_text(run(pairs, demo, args.target_fmr, args.synthetic, label))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
