"""Synthetic score data for exercising the tooling. Contains no faces and no real people."""

from __future__ import annotations

import numpy as np

from tools.int01.groups import ScoredPair


def synthetic_pairs(
    seed: int = 0,
    volunteers: int = 60,
    genuine_per: int = 4,
    impostor_per: int = 30,
) -> tuple[list[ScoredPair], dict[str, dict[str, str]]]:
    rng = np.random.default_rng(seed)
    bands = ["18-29", "30-44", "45+"]
    demographics: dict[str, dict[str, str]] = {}
    pairs: list[ScoredPair] = []
    for n in range(volunteers):
        code = f"syn-{n:04d}"
        band = bands[n % len(bands)]
        demographics[code] = {"age_band": band} if n % 7 else {}
        shift = -0.03 if band == "45+" else 0.0
        for s in rng.normal(0.62 + shift, 0.08, genuine_per):
            pairs.append(ScoredPair(code, "genuine", float(np.clip(s, -1, 1))))
        for s in rng.normal(0.05, 0.10, impostor_per):
            pairs.append(ScoredPair(code, "impostor", float(np.clip(s, -1, 1))))
    return pairs, demographics
