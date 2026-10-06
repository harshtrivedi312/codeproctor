# ruff: noqa: S101, E501
"""INT-01 image-to-score mode tests (FR-403, C-11, C-22). Synthetic images only."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import pytest

from face_helpers import FakeDetector, FakeEmbedder, synthetic_png

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.int01 import evaluate, metrics, score_pairs  # noqa: E402

from worker.config import FaceConfig  # noqa: E402
from worker.face.matcher import FaceMatcher  # noqa: E402
from worker.face.types import DetectedFace  # noqa: E402


def matcher(detector: FakeDetector | None = None) -> FaceMatcher:
    return FaceMatcher(detector or FakeDetector(), FakeEmbedder(), FaceConfig.model_validate({}))


def write_pair(folder: Path, name: str, identity: int) -> Path:
    p = folder / name
    p.write_bytes(synthetic_png(identity))
    return p


def manifest(folder: Path, rows: list[tuple[str, str, str, str]]) -> Path:
    m = folder / "pairs.csv"
    with m.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["subject", "kind", "reference", "probe"])
        w.writerows(rows)
    return m


def test_fr403_genuine_and_impostor_pairs_are_scored_through_the_production_matcher(
    tmp_path: Path,
) -> None:
    write_pair(tmp_path, "a_ref.png", 0)
    write_pair(tmp_path, "a_selfie.png", 0)
    write_pair(tmp_path, "b_ref.png", 1)
    m = manifest(
        tmp_path,
        [
            ("v-a", "genuine", "a_ref.png", "a_selfie.png"),
            ("v-a", "impostor", "b_ref.png", "a_selfie.png"),
        ],
    )
    rows, summary = score_pairs.score_pairs(score_pairs.load_manifest(m), matcher())
    by_kind = {k: s for _, k, s in rows}
    assert by_kind["genuine"] > 0.99 and by_kind["impostor"] < 0.75
    assert summary == score_pairs.ScoringSummary(2, 0, 0)


def test_fr403_unscorable_genuine_counts_as_review_and_unscorable_impostor_is_dropped(
    tmp_path: Path,
) -> None:
    write_pair(tmp_path, "r.png", 0)
    write_pair(tmp_path, "s.png", 0)
    m = manifest(
        tmp_path,
        [
            ("v1", "genuine", "r.png", "s.png"),
            ("v1", "impostor", "r.png", "s.png"),
            ("v2", "genuine", "missing.png", "s.png"),
            ("v2", "impostor", "missing.png", "s.png"),
        ],
    )
    nobody = FakeDetector(lambda _img: [])  # no face is ever found
    rows, summary = score_pairs.score_pairs(score_pairs.load_manifest(m), matcher(nobody))
    assert [(s, k, v) for s, k, v in rows] == [
        ("v1", "genuine", -1.0),
        ("v2", "genuine", -1.0),
    ]
    assert summary == score_pairs.ScoringSummary(0, 2, 2)
    # An unscored genuine pair is a false non-match at every threshold.
    pts = metrics.sweep([-1.0, 0.9], [0.1], [0.5])
    assert pts[0].fnmr == 0.5


def test_fr403_a_below_threshold_pair_keeps_its_score_and_liveness_is_not_a_factor(
    tmp_path: Path,
) -> None:
    write_pair(tmp_path, "r.png", 0)
    write_pair(tmp_path, "s.png", 5)
    m = manifest(tmp_path, [("v", "impostor", "r.png", "s.png")])
    rows, _ = score_pairs.score_pairs(score_pairs.load_manifest(m), matcher())
    assert len(rows) == 1 and -1.0 < rows[0][2] < 0.75


def test_c11_manifest_and_output_refuse_the_repository_and_bad_shapes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / "pairs.csv").write_text("subject,kind,reference,probe\n")
    with pytest.raises(score_pairs.ScoringError, match="outside the repository"):
        score_pairs.load_manifest(repo / "pairs.csv")
    with pytest.raises(score_pairs.ScoringError, match="outside the repository"):
        score_pairs.write_scores(repo / "scores.csv", [])
    bad = tmp_path / "bad.csv"
    bad.write_text("a,b\n1,2\n")
    with pytest.raises(score_pairs.ScoringError, match="columns"):
        score_pairs.load_manifest(bad)
    bad.write_text("subject,kind,reference,probe\n,genuine,a,b\n")
    with pytest.raises(score_pairs.ScoringError, match="subject"):
        score_pairs.load_manifest(bad)
    bad.write_text("subject,kind,reference,probe\n")
    with pytest.raises(score_pairs.ScoringError, match="no rows"):
        score_pairs.load_manifest(bad)
    outside = tmp_path / "pairs.csv"
    outside.write_text(f"subject,kind,reference,probe\nv,genuine,{repo / 'x.png'},s.png\n")
    with pytest.raises(score_pairs.ScoringError, match="images"):
        score_pairs.load_manifest(outside)


def test_c22_the_model_must_sit_in_the_cache_folder_and_scores_are_private(
    tmp_path: Path,
) -> None:
    ok = {"AURAFACE_MODEL_PATH": str(score_pairs.MODELS_DIR / "glintr100.onnx")}
    score_pairs.check_model_location(ok)
    for bad in ({}, {"AURAFACE_MODEL_PATH": str(tmp_path / "glintr100.onnx")}):
        with pytest.raises(score_pairs.ScoringError, match="AURAFACE_MODEL_PATH"):
            score_pairs.check_model_location(bad)
    out = tmp_path / "scores.csv"
    score_pairs.write_scores(out, [("v", "genuine", 0.5)])
    assert oct(out.stat().st_mode & 0o777) == "0o600"
    assert out.read_text().splitlines() == ["subject,kind,score", "v,genuine,0.500000"]
    assert evaluate.load_scores(out)[0].score == 0.5  # the evaluator reads what the scorer wrote


def test_c22_cli_refuses_without_a_model_and_never_writes_photos(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("AURAFACE_MODEL_PATH", raising=False)
    m = manifest(tmp_path, [("v", "genuine", "r.png", "s.png")])
    code = score_pairs.main(["--manifest", str(m), "--out", str(tmp_path / "o.csv")])
    assert code == 2 and "AURAFACE_MODEL_PATH" in capsys.readouterr().err
    assert not (tmp_path / "o.csv").exists()
    monkeypatch.setenv("AURAFACE_MODEL_PATH", str(score_pairs.MODELS_DIR / "nope-glintr100.onnx"))
    code = score_pairs.main(["--manifest", str(m), "--out", str(tmp_path / "o.csv")])
    assert code == 2 and "face model not usable" in capsys.readouterr().err


def test_fr403_one_face_pair_does_not_reuse_a_detector_state(tmp_path: Path) -> None:
    write_pair(tmp_path, "r.png", 0)
    write_pair(tmp_path, "s.png", 0)
    from face_helpers import LANDMARKS

    two = [DetectedFace(LANDMARKS.copy(), 0.99)] * 2
    m = manifest(tmp_path, [("v", "genuine", "r.png", "s.png")])
    rows, summary = score_pairs.score_pairs(
        score_pairs.load_manifest(m), matcher(FakeDetector(two))
    )
    assert rows == [("v", "genuine", -1.0)] and summary.genuine_unscored == 1
