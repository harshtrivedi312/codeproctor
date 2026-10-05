"""FR-803 / TC-074: measured detection on questions with a large starter template.

The starter here is about 780 normalized tokens with three TODO sites. Every starter k-gram is
ignored (identifiers normalize to ID, so generic patterns in the scaffold are ignored too), which
lowers recall when the candidate writes little. Synthetic cases use fixed seeds, so the numbers are
reproducible. Measured on 2026-10-05 (60 pairs per row, peer / AI reference):

| candidate-written code | peer recall | peer FP | AI recall | AI FP |
| 3 sites x 2 statements | 100% | 0%  | 100% | 0% |
| 3 sites x 1 statement  | 98%  | 0%  | 98%  | 0% |
| 1 site x 2 statements  | 97%  | 2%  | 97%  | 2% |
| 1 site x 1 statement   | 48%  | 3%  | 48%  | 0% |

Plain reading: with a large scaffold and a single short fill-in, MORE THAN HALF of genuine copies
are NOT detected (they fall under `minFingerprints`, so no comparison happens). That is the
documented recall gap (docs/followups/integrity.md, MUST-FIX BEFORE PILOT). The floors below sit
about one pair (1/60 = 1.7 points) under the measured values, so a regression fails; they record
current behaviour, are not a target, and must not be loosened to hide a regression. The weak row
is expected to move when the starter-diff proposal is implemented (then raise the floor).
"""

from __future__ import annotations

import random
import re

import pytest

from test_similarity import _OPS, MULTI_TODO, TODO_SITES
from worker.events import CodeLanguage
from worker.similarity import (
    AiReference,
    Submission,
    find_ai_likeness,
    find_peer_similarity,
    normalize,
)

STARTER: dict[CodeLanguage, str] = {"python": MULTI_TODO}
N_PAIRS = 60

TEMPLATES = [
    "{v} = [x {o} {n} for x in items if x {o2} {m}]",
    "for {v} in range(len(items)):\n        if items[{v}] {o} {n} > {m}:\n"
    "            cleaned.append(items[{v}] {o2} {n})",
    "{v} = sum(items[i] {o} i for i in range({n})) {o2} {m}",
    "while {v} < {n}:\n        {v} = {v} {o} {m}\n        cleaned.append({v})",
    "{v} = {{}}\n    for k in items:\n        {v}[k] = {v}.get(k, {n}) {o} {m}",
    "{v} = sorted(items, key=lambda q: (q {o} {n}, q {o2} {m}))",
    "if len(items) {o} {n}:\n        return [{m}]\n    {v} = items[{n}:] {o2} items[:{m}]",
]


def _fills(rng: random.Random, n: int) -> list[str]:
    return [
        rng.choice(TEMPLATES).format(
            v=f"v{rng.randint(0, 99)}",
            o=rng.choice(_OPS[:6]),
            o2=rng.choice(_OPS[:6]),
            n=rng.randint(2, 9),
            m=rng.randint(2, 9),
        )
        for _ in range(n)
    ]


def _build(sites: list[list[str]]) -> str:
    code = MULTI_TODO
    for site, fill in zip(TODO_SITES, sites, strict=True):
        code = code.replace(site, "\n    ".join(fill))
    return code


def _disguise(code: str) -> str:
    """Light renaming and reformatting, as a copier would do."""
    code = re.sub(r"\bv(\d+)\b", lambda m: f"w{int(m.group(1)) + 1}", code)
    return code.replace("  ", " ").replace(" = ", " =  ") + "\n# done\n"


def _solution(rng: random.Random, sites: int, per_site: int) -> str:
    filled = [_fills(rng, per_site) for _ in range(sites)]
    return _build([*filled, *([["pass"]] * (3 - sites))])


def _measure(sites: int, per_site: int) -> tuple[float, float, float, float]:
    peer_hit = peer_fp = ai_hit = ai_fp = 0
    for seed in range(N_PAIRS):
        rng = random.Random(seed)
        a = _solution(rng, sites, per_site)
        copy = _disguise(a)
        other = _solution(rng, sites, per_site)
        sub_a = Submission("a", "qa", "python", a)
        peer_hit += set(
            find_peer_similarity([sub_a, Submission("b", "qb", "python", copy)], None, STARTER)
        ) == {"a", "b"}
        peer_fp += bool(
            find_peer_similarity([sub_a, Submission("c", "qc", "python", other)], None, STARTER)
        )
        ai_hit += bool(find_ai_likeness(sub_a, [AiReference("r", "python", copy)], None, STARTER))
        ai_fp += bool(find_ai_likeness(sub_a, [AiReference("r", "python", other)], None, STARTER))
    n = float(N_PAIRS)
    return peer_hit / n, peer_fp / n, ai_hit / n, ai_fp / n


def test_tc074_fr803_fixture_starter_is_large_but_bounded() -> None:
    assert 700 <= len(normalize(MULTI_TODO, "python")) <= 850


# Floors: about one pair below what is measured on main (recall, then false positives).
@pytest.mark.parametrize(
    ("sites", "per_site", "min_recall", "max_fp"),
    [
        (3, 2, 0.98, 0.02),  # measured 1.00 / 0.00
        (3, 1, 0.96, 0.02),  # measured 0.98 / 0.00
        (1, 2, 0.95, 0.04),  # measured 0.97 / 0.02
        (1, 1, 0.46, 0.05),  # measured 0.483 / 0.033: POOR recall, the documented gap
    ],
)
def test_tc074_fr803_large_starter_recall_and_false_positive_floors(
    sites: int, per_site: int, min_recall: float, max_fp: float
) -> None:
    peer_recall, peer_fp, ai_recall, ai_fp = _measure(sites, per_site)
    msg = (
        f"sites={sites} per_site={per_site} peer_recall={peer_recall:.3f} peer_fp={peer_fp:.3f} "
        f"ai_recall={ai_recall:.3f} ai_fp={ai_fp:.3f} (floors recall>={min_recall}, fp<={max_fp})"
    )
    assert peer_recall >= min_recall and ai_recall >= min_recall, msg
    assert peer_fp <= max_fp and ai_fp <= max_fp, msg
