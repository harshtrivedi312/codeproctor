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
from tools.int01.safety import inside_git_tree  # noqa: E402


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
    assert metrics.upper95(5, 100) == pytest.approx(0.1118, abs=1e-3)


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


def _groups(
    *sizes: int, consent: bool = True
) -> tuple[list[groups.ScoredPair], dict[str, groups.SubjectDemo]]:
    pairs: list[groups.ScoredPair] = []
    demo: dict[str, groups.SubjectDemo] = {}
    n = 0
    for gi, size in enumerate(sizes):
        for _ in range(size):
            code = f"s{n}"
            n += 1
            demo[code] = groups.SubjectDemo(consent, {"age_band": f"G{gi}"})
            pairs += [
                groups.ScoredPair(code, "genuine", 0.8),
                groups.ScoredPair(code, "impostor", 0.1),
            ]
    return pairs, demo


def _rows(
    pairs: list[groups.ScoredPair], demo: dict[str, groups.SubjectDemo]
) -> tuple[list[str], bool]:
    (dim,) = groups.group_report(pairs, demo, 0.5)
    return [r.group for r in dim.rows], dim.hidden


def test_c12_single_small_group_forces_complementary_suppression() -> None:
    # G2 has 9 volunteers. Hiding only G2 would let anyone compute it as total minus shown.
    shown, hidden = _rows(*_groups(12, 15, 9))
    assert hidden and shown == ["G1"]  # G0 (12) is hidden too, so the hidden set is 21 >= 10


def test_c12_dimension_withheld_when_hidden_set_cannot_reach_ten() -> None:
    shown, hidden = _rows(*_groups(9))
    assert shown == [] and hidden
    shown, hidden = _rows(*_groups(12, 3))  # hiding G1 needs G0 hidden too: 15 hidden, none shown
    assert shown == [] and hidden


def test_c12_nothing_hidden_when_every_group_has_ten() -> None:
    shown, hidden = _rows(*_groups(10, 10))
    assert shown == ["G0", "G1"] and not hidden
    with pytest.raises(ValueError):
        groups.group_report(*_groups(10, 10), 0.5, min_group=5)


def test_c12_rendered_report_gives_size_bands_only_never_exact_sizes() -> None:
    pairs, demo = _groups(23, 31, 9, 11)
    (dim,) = groups.group_report(pairs, demo, 0.5)
    rec = metrics.Recommendation(0.1, metrics.sweep([0.8], [0.1], [0.5])[0], "r")
    md = report.render(
        data_label="t", n_volunteers=74, points=[], rec=rec, groups=[dim], synthetic=True
    )
    for exact in ("| 23 |", "| 31 |", "| 9 |", "| 11 |"):
        assert exact not in md
    assert "20-49" in md


def test_c12_only_volunteers_with_group_consent_count_in_groups() -> None:
    pairs, demo = _groups(12, 12)
    for code in list(demo)[:6]:  # 6 of G0 did not tick box C
        demo[code] = groups.SubjectDemo(False, demo[code].values)
    shown, hidden = _rows(pairs, demo)
    # G0 has 6 consenting volunteers and is hidden; with the 6 non-consenters the residual is 12,
    # which is safe, so G1 may be shown.
    assert hidden and shown == ["G1"]
    assert groups.group_report(pairs, {}, 0.5) == []  # no consent entries: no group section


def test_c12_demographics_file_is_strict(tmp_path: Path) -> None:
    for bad in (
        {"a": {"age_band": "30-44"}},  # consent flag missing
        {"a": {"consent_group_results": "yes", "age_band": "30-44"}},  # not a boolean
        {"a": {"consent_group_results": True, "age_band": "<b>x</b>\n| evil |"}},  # markup
        {"a": {"consent_group_results": True, "full_name": "Ada"}},  # not a form dimension
    ):
        with pytest.raises(ValueError):
            groups.parse_subject_demo(next(iter(bad.values())))
    ok = groups.parse_subject_demo({"consent_group_results": True, "age_band": groups.UNKNOWN})
    assert ok.consent_group_results and ok.values["age_band"] == groups.UNKNOWN


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
    assert not inside_git_tree(tmp_path / "elsewhere.json")


class _OneFace:
    def __init__(self, boxes: list[intake.Box]) -> None:
        self.boxes = boxes

    def locate(self, image: intake.Image) -> list[intake.Box]:
        return self.boxes


def _write_png(path: Path) -> None:
    from PIL import Image as PIL

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
    src = tmp_path / "id.png"
    src.write_bytes(b"not an image")
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, tmp_path / "p.png", _OneFace([]))
    assert ei.value.code == "UNREADABLE" and not src.exists()


def test_c11_intake_refuses_unsafe_paths_and_touches_nothing(tmp_path: Path) -> None:
    src = tmp_path / "id.png"
    _write_png(src)
    link = tmp_path / "link.png"
    link.symlink_to(src)
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    for s_, d_ in (
        (link, tmp_path / "o.png"),
        (src, src),
        (src, repo / "o.png"),
        (tmp_path / "none.png", tmp_path / "o.png"),
    ):
        with pytest.raises(intake.IntakeError) as ei:
            intake.intake_id_photo(s_, d_, _OneFace([intake.Box(100, 50, 160, 130)]))
        assert ei.value.code == "PATH_REFUSED"
    assert src.exists()


def test_c11_intake_reports_delete_failure_and_removes_the_crop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, dest = tmp_path / "id.png", tmp_path / "portrait.png"
    _write_png(src)
    monkeypatch.setattr(intake, "_delete_original", lambda p: False)
    with pytest.raises(intake.IntakeError) as ei:
        intake.intake_id_photo(src, dest, _OneFace([intake.Box(100, 50, 160, 130)]))
    assert ei.value.code == "DELETE_FAILED" and not dest.exists()


def test_c11_intake_leaves_no_temp_crop_when_encoding_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, out = tmp_path / "id.png", tmp_path / "out"
    _write_png(src)

    def boom(*a: object, **k: object) -> None:
        raise ValueError("encode")

    monkeypatch.setattr("PIL.Image.Image.save", boom)
    with pytest.raises(ValueError):
        intake.intake_id_photo(src, out / "p.png", _OneFace([intake.Box(100, 50, 160, 130)]))
    assert not src.exists() and list(out.iterdir()) == []


def test_scores_csv_header_is_validated(tmp_path: Path) -> None:
    f = tmp_path / "s.csv"
    f.write_text("a,b\n1,2\n")
    with pytest.raises(ValueError, match="columns"):
        evaluate.load_scores(f)


def _mixed(
    sizes: list[int], non_consenters: int = 0, no_genuine: int = 0
) -> tuple[list[groups.ScoredPair], dict[str, groups.SubjectDemo]]:
    pairs, demo = _groups(*sizes)
    codes = list(demo)
    for code in codes[len(codes) - non_consenters :]:
        demo[code] = groups.SubjectDemo(False, demo[code].values)
    skip = set(codes[:no_genuine])  # failed ID intake: impostor probes only
    pairs = [p for p in pairs if not (p.subject in skip and p.kind == "genuine")]
    return pairs, demo


def test_c12_one_non_consenter_cannot_be_derived_from_overall_totals() -> None:
    pairs, demo = _mixed([20, 20, 20], non_consenters=1)
    (dim,) = groups.group_report(pairs, demo, 0.5)
    shown = {r.group for r in dim.rows}
    rest = {p.subject for p in pairs} - {
        c for c, d in demo.items() if d.values["age_band"] in shown and d.consent_group_results
    }
    assert len(shown) < 3 and len(rest) >= 10 and dim.hidden


def test_c12_group_needs_ten_volunteers_with_genuine_pairs_not_ten_members() -> None:
    pairs, demo = _mixed([12, 15], no_genuine=11)  # only 1 of G0 has genuine pairs
    shown, hidden = _rows(pairs, demo)
    assert "G0" not in shown and hidden
    pairs, demo = _mixed([12, 15, 14], no_genuine=0)
    pairs = [p for p in pairs if p.subject not in {"s0", "s1"} or True]
    assert _rows(pairs, demo)[0] == ["G0", "G1", "G2"]  # nothing hidden: nothing to protect


def test_c12_malformed_demographics_file_gives_clear_error(tmp_path: Path) -> None:
    f = tmp_path / "d.json"
    f.write_text("[1]")
    with pytest.raises(ValueError, match="per-volunteer"):
        evaluate.load_demographics(f)
