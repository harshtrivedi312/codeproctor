"""Per-group breakdown with small groups suppressed (C-12, volunteer form section 3).

A group is counted in distinct volunteers, not pairs. A group with fewer than `min_group`
volunteers is reported only as "suppressed": no rates, no size. The group of an impostor pair is
the group of its probe volunteer. Demographic data comes from a separate file and is optional.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tools.int01.metrics import ThresholdPoint, sweep

MIN_GROUP = 10
UNKNOWN = "prefer not to say"


@dataclass(frozen=True, slots=True)
class ScoredPair:
    subject: str  # random volunteer code, never a name; not written to the report
    kind: str  # "genuine" or "impostor"
    score: float


@dataclass(frozen=True, slots=True)
class GroupRow:
    group: str
    volunteers: int
    point: ThresholdPoint


@dataclass(frozen=True, slots=True)
class DimensionReport:
    dimension: str
    rows: tuple[GroupRow, ...]
    suppressed_groups: int  # how many groups were hidden; their names and sizes are not given


def group_report(
    pairs: Sequence[ScoredPair],
    demographics: Mapping[str, Mapping[str, str]],
    threshold: float,
    min_group: int = MIN_GROUP,
) -> list[DimensionReport]:
    """`demographics` maps subject code -> {dimension: value}. Missing means UNKNOWN."""
    if min_group < MIN_GROUP:
        raise ValueError(f"min_group must be at least {MIN_GROUP} (C-12)")
    dimensions = sorted({d for attrs in demographics.values() for d in attrs})
    subjects = {p.subject for p in pairs}
    reports: list[DimensionReport] = []
    for dim in dimensions:
        by_group: dict[str, set[str]] = {}
        for s in subjects:
            by_group.setdefault(demographics.get(s, {}).get(dim, UNKNOWN), set()).add(s)
        rows: list[GroupRow] = []
        suppressed = 0
        for group in sorted(by_group):
            members = by_group[group]
            g = [p.score for p in pairs if p.subject in members and p.kind == "genuine"]
            i = [p.score for p in pairs if p.subject in members and p.kind == "impostor"]
            # A group needs both pair kinds, otherwise a rate cannot be computed.
            if len(members) < min_group or not g or not i:
                suppressed += 1
                continue
            rows.append(GroupRow(group, len(members), sweep(g, i, [threshold])[0]))
        reports.append(DimensionReport(dim, tuple(rows), suppressed))
    return reports
