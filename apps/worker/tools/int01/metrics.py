"""False-match and false-non-match rates across thresholds, and a recommended threshold.

A pair is called a MATCH when its score is >= the threshold, otherwise it goes to manual review
(never a rejection, D-05). FMR is the share of impostor pairs wrongly called MATCH. FNMR is the
share of genuine pairs sent to manual review, so it is also the expected manual-review rate for
honest candidates.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

Scores = npt.NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class ThresholdPoint:
    threshold: float
    fmr: float
    fnmr: float
    false_matches: int
    false_non_matches: int
    n_impostor: int
    n_genuine: int
    # 95% upper bound; the "rule of three" (3/n) when the count is zero.
    fmr_upper95: float
    fnmr_upper95: float


@dataclass(frozen=True, slots=True)
class Recommendation:
    target_fmr: float
    point: ThresholdPoint | None  # None when no swept threshold meets the target
    reason: str


def _as_scores(values: Sequence[float] | Scores, label: str) -> Scores:
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError(f"{label} scores must be a non-empty 1-D sequence")
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{label} scores must be finite")
    return arr


def upper95(count: int, n: int) -> float:
    """Wilson 95% upper bound, or the rule of three when count is zero."""
    if n <= 0:
        raise ValueError("n must be positive")
    if count == 0:
        return min(1.0, 3.0 / n)
    z = 1.959963984540054
    p = count / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return min(1.0, (centre + margin) / denom)


def sweep(
    genuine: Sequence[float] | Scores,
    impostor: Sequence[float] | Scores,
    thresholds: Sequence[float] | Scores,
) -> list[ThresholdPoint]:
    g = np.sort(_as_scores(genuine, "genuine"))
    i = np.sort(_as_scores(impostor, "impostor"))
    out: list[ThresholdPoint] = []
    for t in np.asarray(thresholds, dtype=np.float64):
        fnm = int(np.searchsorted(g, t, side="left"))  # genuine with score < t
        fm = int(i.size - np.searchsorted(i, t, side="left"))  # impostor with score >= t
        out.append(
            ThresholdPoint(
                threshold=float(t),
                fmr=fm / i.size,
                fnmr=fnm / g.size,
                false_matches=fm,
                false_non_matches=fnm,
                n_impostor=int(i.size),
                n_genuine=int(g.size),
                fmr_upper95=upper95(fm, int(i.size)),
                fnmr_upper95=upper95(fnm, int(g.size)),
            )
        )
    return out


def default_thresholds() -> Scores:
    return np.round(np.arange(0.0, 1.0001, 0.01), 2)


def recommend(points: Sequence[ThresholdPoint], target_fmr: float) -> Recommendation:
    """Lowest threshold whose 95% upper bound on FMR is within the target.

    Using the upper bound (not the point estimate) stops a small sample from looking safer than
    it is. Lowest qualifying threshold means the fewest manual reviews.
    """
    if not 0 < target_fmr < 1:
        raise ValueError("target_fmr must be between 0 and 1")
    for p in sorted(points, key=lambda p: p.threshold):
        if p.fmr_upper95 <= target_fmr:
            return Recommendation(
                target_fmr, p, "Lowest threshold whose 95% upper bound on FMR meets the target."
            )
    return Recommendation(
        target_fmr,
        None,
        "No swept threshold meets the target at this sample size; collect more impostor pairs.",
    )
