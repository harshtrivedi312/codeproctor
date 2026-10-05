"""INT-01 tooling tests. Run from apps/worker: pytest tools/int01/tests -p no:cacheprovider
(FR-403, D-05, C-12). Synthetic data only."""

# ruff: noqa: S101, E501
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.int01 import evaluate, groups, intake, metrics, report, synthetic  # noqa: E402


def test_fr403_sweep_counts_match_rule_score_equal_to_threshold_is_match() -> None:
    pts = metrics.sweep([0.5, 0.6, 0.7, 0.8], [0.1, 0.5, 0.2, 0.3], [0.5])
    p = pts[0]
    assert p.false_matches == 1  # impostor 0.5 >= 0.5
    assert p.false_non_matches == 0  # genuine 0.5 is not < 0.5
    assert p.fmr == 0.25 and p.fnmr == 0.0


def test_fr403_rates_move_monotonically_with_threshold() -> None:
    pairs, _ = synthetic.synthetic_pairs()
    g = [p.score for p in pairs if p.kind == "genuine"]
    i = [p.score for p in pairs if p.kind == "impostor"]
    pts = metrics.sweep(g, i, metrics.default_thresholds())
    assert all(a.fmr >= b.fmr for a, b in zip(pts, pts[1:], strict=False))
    assert all(a.fnmr <= b.fnmr for a, b in zip(pts, pts[1:], strict=False))


def test_zero_count_uses_rule_of_three_and_wilson_otherwise() -> None:
    assert metrics.upper95(0, 300) == pytest.approx(0.01)
    assert metrics.upper95(5, 100) > 0.05


@pytest.mark.parametrize("bad", [[], [float("nan")], [float("inf")]])
def test_invalid_scores_rejected(bad: list[float]) -> None:
    with pytest.raises(ValueError):
        metrics.sweep(bad, [0.1], [0.5])


def test_recommend_uses_upper_bound_and_reports_when_sample_too_small() -> None:
    g = [0.9] * 50
    i = [0.0] * 50  # 0 false matches, but 3/50 = 6% upper bound
    pts = metrics.sweep(g, i, metrics.default_thresholds())
    assert metrics.recommend(pts, 0.001).point is None
    assert metrics.recommend(pts, 0.10).point is not None
    with pytest.raises(ValueError):
        metrics.recommend(pts, 0)


def _two_groups(n_a: int, n_b: int) -> tuple[list[groups.ScoredPair], dict[str, dict[str, str]]]:
    pairs: list[groups.ScoredPair] = []
    demo: dict[str, dict[str, str]] = {}
    for n in range(n_a + n_b):
        code = f"s{n}"
        demo[code] = {"band": "A" if n < n_a else "B"}
        pairs += [groups.ScoredPair(code, "genuine", 0.8), groups.ScoredPair(code, "impostor", 0.1)]
    return pairs, demo


def test_c12_groups_under_ten_volunteers_are_suppressed_without_size() -> None:
    pairs, demo = _two_groups(12, 9)
    (dim,) = groups.group_report(pairs, demo, 0.5)
    assert [r.group for r in dim.rows] == ["A"]
    assert dim.suppressed_groups == 1
    md = report.render(
        data_label="t",
        n_volunteers=21,
        points=[],
        rec=metrics.Recommendation(0.1, metrics.sweep([0.8], [0.1], [0.5])[0], "r"),
        groups=[dim],
        synthetic=True,
    )
    assert "| B |" not in md and "| 9 |" not in md


def test_c12_group_of_exactly_ten_is_shown_and_min_group_cannot_be_lowered() -> None:
    pairs, demo = _two_groups(10, 10)
    (dim,) = groups.group_report(pairs, demo, 0.5)
    assert len(dim.rows) == 2 and dim.suppressed_groups == 0
    with pytest.raises(ValueError):
        groups.group_report(pairs, demo, 0.5, min_group=5)


def test_report_never_contains_subject_codes_and_marks_synthetic() -> None:
    pairs, demo = synthetic.synthetic_pairs()
    md = evaluate.run(pairs, demo, 0.05, True, "synthetic")
    assert "syn-0001" not in md
    assert "SYNTHETIC DATA. Not a result." in md
    assert "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60" in md


def test_cli_synthetic_and_refuses_inputs_inside_git_tree(tmp_path: Path) -> None:
    out = tmp_path / "r.md"
    assert evaluate.main(["--synthetic", "--out", str(out)]) == 0
    assert out.read_text().startswith("# Face-match threshold report")
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)  # in a linked worktree .git is a file; exists() covers both
    for name, loader in (("d.json", evaluate.load_demographics), ("s.csv", evaluate.load_scores)):
        (repo / name).write_text("{}")
        with pytest.raises(ValueError, match="outside the repository"):
            loader(repo / name)
    assert not evaluate.inside_git_tree(tmp_path / "elsewhere.json")


class _OneFace:
    def __init__(self, boxes: list[intake.Box]) -> None:
        self.boxes = boxes

    def locate(self, image: intake.Image) -> list[intake.Box]:
        return self.boxes


def _write_png(path: Path) -> None:
    PIL = pytest.importorskip("PIL.Image")
    arr = np.random.default_rng(0).integers(0, 255, (200, 300, 3), dtype=np.uint8)
    PIL.fromarray(arr, "RGB").save(path)


def test_c11_intake_keeps_only_portrait_and_deletes_original(tmp_path: Path) -> None:
    src, dest = tmp_path / "id.png", tmp_path / "out" / "portrait.png"
    _write_png(src)
    intake.intake_id_photo(src, dest, _OneFace([intake.Box(100, 50, 160, 130)]))
    assert not src.exists() and dest.exists()
    assert oct(dest.stat().st_mode & 0o777) == "0o600"
    from PIL import Image

    with Image.open(dest) as im:
        assert im.size[0] < 300 and im.size[1] < 200
        assert not im.getexif()


@pytest.mark.parametrize(
    ("boxes", "code"),
    [([], "NO_FACE"), ([intake.Box(0, 0, 10, 10), intake.Box(50, 50, 90, 90)], "MULTIPLE_FACES")],
)
def test_c11_intake_failure_still_deletes_original_and_writes_nothing(
    tmp_path: Path, boxes: list[intake.Box], code: str
) -> None:
    src, dest = tmp_path / "id.png", tmp_path / "portrait.png"
    _write_png(src)
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, dest, _OneFace(boxes))
    assert ei.value.code == code
    assert not src.exists() and not dest.exists()


def test_c11_intake_unreadable_file_is_deleted(tmp_path: Path) -> None:
    pytest.importorskip("PIL")
    src = tmp_path / "id.png"
    src.write_bytes(b"not an image")
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, tmp_path / "p.png", _OneFace([]))
    assert ei.value.code == "UNREADABLE" and not src.exists()
