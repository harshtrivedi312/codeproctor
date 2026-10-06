"""BE-08 face benchmark (ADR 0014 6.6): the no-cache default, with the real AuraFace model.

    AURAFACE_MODEL_PATH=~/.cache/codeproctor/models/glintr100.onnx \\
        python -m tools.be08.bench_embedding [--runs 60] [--threads 1 2 4]

Times one embedding (the model only, on a synthetic 112x112 crop, no photos) sequentially and
with several threads, then works out what a re-check costs at 200 concurrent candidates: one
frame every 120 s each gives about 1.7 re-checks per second, and with no selfie cache each
re-check computes TWO embeddings (about 3.3 per second), on top of the initial matches.
Face DETECTION (MediaPipe) is not timed here: it needs `face_landmarker.task`, which is not
downloaded (C-22 approves glintr100.onnx only). Numbers are for the machine that ran this, not
the ARC-05 instance type; rerun there before DEP-03. Prints numbers only: no paths, no images.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from worker.face.embedding import AuraFaceEmbedder
from worker.face.modelfile import ModelLoadError
from worker.face.types import ALIGNED_SIZE, AlignedFace

CANDIDATES = 200
RECHECK_INTERVAL_S = 120
EMBEDDINGS_PER_RECHECK = 2  # frame and selfie: nothing is cached by default (ADR 0014 6.3)
INITIAL_MATCHES = 200  # starts bunch within about 10 minutes (ADR 0014 6.6); 2 embeddings each
INITIAL_WINDOW_S = 600


@dataclass(frozen=True, slots=True)
class Timing:
    threads: int
    runs: int
    p50_ms: float
    p95_ms: float
    per_second: float


def _crop(seed: int) -> AlignedFace:
    rng = np.random.default_rng(seed)
    return AlignedFace(rng.integers(0, 256, (ALIGNED_SIZE, ALIGNED_SIZE, 3), dtype=np.uint8))


def time_embeddings(embedder: AuraFaceEmbedder, runs: int, threads: int) -> Timing:
    crops = [_crop(i) for i in range(min(runs, 8))]
    embedder.embed(crops[0])  # warm-up, not timed

    def one(i: int) -> float:
        t0 = time.perf_counter()
        embedder.embed(crops[i % len(crops)])
        return (time.perf_counter() - t0) * 1000

    wall0 = time.perf_counter()
    if threads == 1:
        samples = [one(i) for i in range(runs)]
    else:
        with ThreadPoolExecutor(max_workers=threads) as pool:
            samples = list(pool.map(one, range(runs)))
    wall = time.perf_counter() - wall0
    ordered = sorted(samples)
    return Timing(
        threads,
        runs,
        statistics.median(ordered),
        statistics.quantiles(ordered, n=20)[-1],
        runs / wall,
    )


def required_rate() -> tuple[float, float]:
    """(steady re-check embeddings per second, initial-match embeddings per second at the peak)."""
    steady = CANDIDATES / RECHECK_INTERVAL_S * EMBEDDINGS_PER_RECHECK
    peak_initial = INITIAL_MATCHES / INITIAL_WINDOW_S * 2
    return steady, peak_initial


def check_model_location() -> None:
    from tools.int01.score_pairs import ScoringError
    from tools.int01.score_pairs import check_model_location as check

    try:
        check({"AURAFACE_MODEL_PATH": os.environ.get("AURAFACE_MODEL_PATH", "")})
    except ScoringError as e:
        raise SystemExit(f"{e} (C-22)") from None


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--runs", type=int, default=60)
    ap.add_argument("--threads", type=int, nargs="+", default=[1, 2, 4])
    args = ap.parse_args(argv)
    if args.runs < 2:
        ap.error("--runs must be at least 2")
    check_model_location()
    try:
        embedder = AuraFaceEmbedder.from_env()
    except ModelLoadError as e:
        print(f"model not usable: {e.code}", file=sys.stderr)
        return 2
    steady, initial = required_rate()
    print(f"cpu count: {os.cpu_count()}")
    print(
        f"needed at {CANDIDATES} candidates: {steady:.1f} embeddings/s steady (re-checks, no "
        f"cache), plus {initial:.1f}/s during the initial-match peak"
    )
    for threads in args.threads:
        t = time_embeddings(embedder, args.runs, threads)
        verdict = "enough" if t.per_second >= steady + initial else "NOT enough"
        print(
            f"threads={t.threads} runs={t.runs} p50={t.p50_ms:.1f} ms p95={t.p95_ms:.1f} ms "
            f"throughput={t.per_second:.1f}/s -> {verdict} for steady plus peak"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
