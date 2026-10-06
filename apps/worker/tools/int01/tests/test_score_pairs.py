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
    by_kind = {k: s for _, k, s, _st in rows}
    g, i = by_kind["genuine"], by_kind["impostor"]
    assert g is not None and i is not None and g > 0.99 and i < 0.75
    assert summary == score_pairs.ScoringSummary(2, 0, 0, 0)


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
    assert rows == [
        ("v1", "genuine", -1.0, "unscored"),  # no face was found
        ("v1", "impostor", None, "unscored"),
        ("v2", "genuine", None, "missing"),  # the file does not exist: a manifest error
        ("v2", "impostor", None, "missing"),
    ]
    assert summary == score_pairs.ScoringSummary(0, 1, 1, 2)
    # An unscored genuine pair is a false non-match at every threshold.
    pts = metrics.sweep([-1.0, 0.9], [0.1], [0.5])
    assert pts[0].fnmr == 0.5


def test_fr403_a_below_threshold_pair_keeps_its_score(
    tmp_path: Path,
) -> None:
    write_pair(tmp_path, "r.png", 0)
    write_pair(tmp_path, "s.png", 5)
    m = manifest(tmp_path, [("v", "impostor", "r.png", "s.png")])
    rows, _ = score_pairs.score_pairs(score_pairs.load_manifest(m), matcher())
    score = rows[0][2]
    assert score is not None and -1.0 < score < 0.75


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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(score_pairs, "MODELS_DIR", tmp_path / "models")
    (tmp_path / "models").mkdir()
    ok = {"AURAFACE_MODEL_PATH": str(score_pairs.MODELS_DIR / "glintr100.onnx")}
    score_pairs.check_model_location(ok)
    for bad in ({}, {"AURAFACE_MODEL_PATH": str(tmp_path / "glintr100.onnx")}):
        with pytest.raises(score_pairs.ScoringError, match="AURAFACE_MODEL_PATH"):
            score_pairs.check_model_location(bad)
    out = tmp_path / "scores.csv"
    score_pairs.write_scores(out, [("v", "genuine", 0.5, "scored")])
    assert oct(out.stat().st_mode & 0o777) == "0o600"
    assert out.read_text().splitlines() == [
        "subject,kind,score,status",
        "v,genuine,0.500000,scored",
    ]
    assert evaluate.load_scores(out)[0].score == 0.5  # the evaluator reads what the scorer wrote


def test_c22_cli_refuses_without_a_model_and_writes_nothing(
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


def test_fr403_a_probe_with_several_faces_is_unscored(tmp_path: Path) -> None:
    write_pair(tmp_path, "r.png", 0)
    write_pair(tmp_path, "s.png", 0)
    from face_helpers import LANDMARKS

    two = [DetectedFace(LANDMARKS.copy(), 0.99)] * 2
    m = manifest(tmp_path, [("v", "genuine", "r.png", "s.png")])
    rows, summary = score_pairs.score_pairs(
        score_pairs.load_manifest(m), matcher(FakeDetector(two))
    )
    assert rows == [("v", "genuine", -1.0, "unscored")] and summary.genuine_unscored == 1


def test_c11_scores_file_is_0600_even_over_an_existing_wider_file_and_refuses_links(
    tmp_path: Path,
) -> None:
    import os

    out = tmp_path / "scores.csv"
    out.write_text("old")
    out.chmod(0o644)
    score_pairs.write_scores(out, [("v", "genuine", 0.5, "scored")])
    assert oct(out.stat().st_mode & 0o777) == "0o600" and "old" not in out.read_text()
    link = tmp_path / "link.csv"
    link.symlink_to(out)
    with pytest.raises(score_pairs.ScoringError, match="cannot be written"):
        score_pairs.write_scores(link, [])
    fifo = tmp_path / "pipe.csv"
    os.mkfifo(fifo)
    with pytest.raises(score_pairs.ScoringError):
        score_pairs.write_scores(fifo, [])


def test_fr403_unscored_rows_roundtrip_into_the_evaluator_and_the_report(tmp_path: Path) -> None:
    out = tmp_path / "scores.csv"
    rows: list[score_pairs.Row] = (
        [(f"v{n:02d}", "genuine", 0.9, "scored") for n in range(18)]
        + [("v18", "genuine", -1.0, "unscored"), ("v19", "genuine", -1.0, "unscored")]
        + [(f"v{n:02d}", "impostor", 0.05, "scored") for n in range(20) for _ in range(3)]
        + [("v00", "impostor", None, "unscored"), ("v01", "genuine", None, "missing")]
    )
    score_pairs.write_scores(out, rows)
    pairs = evaluate.load_scores(out)
    md = evaluate.run(pairs, {}, 0.5, False, "t")
    assert "2 of 20 genuine pairs could not be scored" in md
    assert "1 impostor pairs could not be scored" in md
    assert "1 pairs named image files that could not be read" in md
    assert "liveness" in md and "presentation attacks" in md


def test_c11_manifest_codes_and_paths_are_checked(tmp_path: Path) -> None:
    sub = tmp_path / "sub"
    sub.mkdir()
    write_pair(sub, "r.png", 0)
    write_pair(tmp_path, "outside.png", 0)
    for code in ("=cmd", "+1", "-A1", "a b", "a,b", ""):
        m = manifest(sub, [(code, "genuine", "r.png", "r.png")])
        with pytest.raises(score_pairs.ScoringError, match="subject code"):
            score_pairs.load_manifest(m)
    m = manifest(sub, [("v", "genuine", "../outside.png", "r.png")])
    with pytest.raises(score_pairs.ScoringError, match="inside the manifest"):
        score_pairs.load_manifest(m)
    assert score_pairs.load_manifest(m, allow_outside=True)


def test_c22_landmarker_model_and_symlinked_models_folder_are_checked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(score_pairs, "MODELS_DIR", tmp_path / "models")
    (tmp_path / "models").mkdir()
    good = {"AURAFACE_MODEL_PATH": str(score_pairs.MODELS_DIR / "glintr100.onnx")}
    score_pairs.check_model_location(
        good | {"FACE_LANDMARKER_MODEL_PATH": str(score_pairs.MODELS_DIR / "face_landmarker.task")}
    )
    with pytest.raises(score_pairs.ScoringError, match="FACE_LANDMARKER_MODEL_PATH"):
        score_pairs.check_model_location(
            good | {"FACE_LANDMARKER_MODEL_PATH": str(tmp_path / "face_landmarker.task")}
        )
    link = tmp_path / "models-link"
    link.symlink_to(tmp_path)
    monkeypatch.setattr(score_pairs, "MODELS_DIR", link)
    with pytest.raises(score_pairs.ScoringError, match="symlink"):
        score_pairs.check_model_location({"AURAFACE_MODEL_PATH": str(link / "glintr100.onnx")})


def test_c11_main_never_prints_paths_or_subject_codes_and_stops_on_unreadable_images(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = tmp_path / "SECRET-folder" / "pairs.csv"
    monkeypatch.setattr(score_pairs, "check_model_location", lambda *a, **k: None)
    code = score_pairs.main(["--manifest", str(secret), "--out", str(tmp_path / "o.csv")])
    out = capsys.readouterr()
    assert code == 2 and "SECRET" not in out.err and "SECRET" not in out.out
    # an unreadable image stops the run unless --allow-missing is given
    write_pair(tmp_path, "r.png", 0)
    m = manifest(tmp_path, [("vol-SECRETCODE", "genuine", "r.png", "missing.png")])
    monkeypatch.setattr("worker.face.factory.build_face_matcher", lambda: matcher())
    code = score_pairs.main(["--manifest", str(m), "--out", str(tmp_path / "o.csv")])
    out = capsys.readouterr()
    assert code == 2 and not (tmp_path / "o.csv").exists()
    assert "SECRETCODE" not in out.err + out.out and "missing.png" not in out.err + out.out
    code = score_pairs.main(
        ["--manifest", str(m), "--out", str(tmp_path / "o.csv"), "--allow-missing"]
    )
    out = capsys.readouterr()
    assert code == 0 and (tmp_path / "o.csv").exists() and "unreadable files: 1" in out.out
    assert "missing" in (tmp_path / "o.csv").read_text()
    assert "SECRETCODE" not in out.out + out.err and "min detection confidence" in out.out


def test_fr403_evaluator_never_trusts_an_unscored_cell_and_drops_missing_pairs(
    tmp_path: Path,
) -> None:
    f = tmp_path / "s.csv"
    f.write_text(
        "subject,kind,score,status\n"
        "a,genuine,0.99,unscored\n"  # a hand-edited cell: still a false non-match
        "b,genuine,,unscored\n"  # an empty cell must not crash the metrics
        "c,impostor,0.99,unscored\n"  # ignored: cannot be a false match
        "d,impostor,0.1,scored\n"
        "e,genuine,,missing\n"
        "f,genuine,0.9,scored\n"
    )
    pairs = {p.subject: p for p in evaluate.load_scores(f)}
    assert pairs["a"].score == -1.0 and pairs["b"].score == -1.0
    assert pairs["e"].missing and not pairs["a"].missing
    md = evaluate.run(list(pairs.values()), {}, 0.5, False, "t")
    assert "2 of 3 genuine pairs could not be scored" in md  # e (missing) is not counted
    f.write_text("subject,kind,score,status\nx,genuine,abc,scored\n")
    with pytest.raises(ValueError, match="number"):
        evaluate.load_scores(f)
    f.write_text("subject,kind,score,status\nx,genuine,0.5,bogus\n")
    with pytest.raises(ValueError, match="status"):
        evaluate.load_scores(f)


def test_c11_evaluator_cli_prints_fixed_text_never_a_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    gone = tmp_path / "SECRET-dir" / "scores.csv"
    assert evaluate.main(["--scores", str(gone), "--out", str(tmp_path / "r.md")]) == 2
    err = capsys.readouterr().err
    assert "SECRET" not in err and "could not be read" in err
    f = tmp_path / "s.csv"
    f.write_text("subject,kind,score\nv,genuine,0.9\n")  # no impostors: the metrics refuse it
    assert evaluate.main(["--scores", str(f), "--out", str(tmp_path / "r.md")]) == 2
    assert "impostor" in capsys.readouterr().err
    out_dir = tmp_path / "no-such-dir-SECRET" / "r.md"
    assert evaluate.main(["--synthetic", "--out", str(out_dir)]) == 2
    assert "SECRET" not in capsys.readouterr().err


def test_c11_images_are_read_safely_and_short_rows_and_hard_links_are_refused(
    tmp_path: Path,
) -> None:
    import os

    fifo = tmp_path / "pipe.png"
    os.mkfifo(fifo)
    with pytest.raises(OSError):
        score_pairs._read_image(fifo)  # noqa: SLF001 - must not hang on a FIFO
    link = tmp_path / "link.png"
    link.symlink_to(write_pair(tmp_path, "real.png", 0))
    with pytest.raises(OSError):
        score_pairs._read_image(link)  # noqa: SLF001
    big = tmp_path / "big.png"
    big.write_bytes(b"x" * (score_pairs.MAX_IMAGE_FILE_BYTES + 1))
    with pytest.raises(OSError):
        score_pairs._read_image(big)  # noqa: SLF001
    short = tmp_path / "short.csv"
    short.write_text("subject,kind,reference,probe\nv,genuine,a.png\n")
    with pytest.raises(score_pairs.ScoringError, match="four columns"):
        score_pairs.load_manifest(short)
    out = tmp_path / "scores.csv"
    out.write_text("old")
    os.link(out, tmp_path / "second-name.csv")
    with pytest.raises(score_pairs.ScoringError, match="one name"):
        score_pairs.write_scores(out, [])
    assert out.read_text() == "old"  # nothing was truncated before the refusal
