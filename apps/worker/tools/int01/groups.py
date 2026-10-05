"""Per-group breakdown with small groups suppressed (C-12, volunteer form sections 3 and 9).

- Only volunteers who ticked box C (`consent_group_results`) are counted in any group. Everyone
  else stays in the overall totals only.
- A group is counted in distinct volunteers, not pairs. A group with fewer than `min_group`
  volunteers is hidden. The group of an impostor pair is the group of its probe volunteer.
- Complementary suppression: if the hidden groups together have fewer than `min_group`
  volunteers, the smallest shown groups are hidden too, until the hidden set is large enough.
  Otherwise a hidden group could be worked out by subtracting the shown groups from the totals.
  If that cannot be done, the whole dimension is withheld.
- Exact group sizes are never printed, only size bands.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tools.int01.metrics import ThresholdPoint, sweep

MIN_GROUP = 10
UNKNOWN = "prefer not to say"
CONSENT_KEY = "consent_group_results"
_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 +<>/.\-]{0,23}$")


@dataclass(frozen=True, slots=True)
class ScoredPair:
    subject: str  # random volunteer code, never a name; not written to the report
    kind: str  # "genuine" or "impostor"
    score: float


@dataclass(frozen=True, slots=True)
class SubjectDemo:
    consent_group_results: bool
    values: Mapping[str, str]  # dimension -> value; a consenting volunteer may use UNKNOWN


def parse_subject_demo(raw: Mapping[str, object]) -> SubjectDemo:
    """Strict: the consent flag must be present and a real boolean; values must be short plain
    labels (no free text, no markup)."""
    flag = raw.get(CONSENT_KEY)
    if not isinstance(flag, bool):
        raise ValueError(f"{CONSENT_KEY} must be true or false for every volunteer")
    values: dict[str, str] = {}
    for key, val in raw.items():
        if key == CONSENT_KEY:
            continue
        if not isinstance(val, str) or not (val == UNKNOWN or _VALUE.match(val)):
            raise ValueError(f"invalid value for {key!r}")
        values[key] = val
    return SubjectDemo(flag, values)


@dataclass(frozen=True, slots=True)
class GroupRow:
    group: str
    size_band: str
    point: ThresholdPoint


@dataclass(frozen=True, slots=True)
class DimensionReport:
    dimension: str
    rows: tuple[GroupRow, ...]
    hidden: bool  # something was hidden; names and sizes are not given


def size_band(n: int) -> str:
    if n < 20:
        return "10-19"
    if n < 50:
        return "20-49"
    if n < 100:
        return "50-99"
    return "100+"


def group_report(
    pairs: Sequence[ScoredPair],
    demographics: Mapping[str, SubjectDemo],
    threshold: float,
    min_group: int = MIN_GROUP,
) -> list[DimensionReport]:
    if min_group < MIN_GROUP:
        raise ValueError(f"min_group must be at least {MIN_GROUP} (C-12)")
    eligible = {s for s, d in demographics.items() if d.consent_group_results}
    subjects = {p.subject for p in pairs} & eligible
    dimensions = sorted({d for s in subjects for d in demographics[s].values})
    reports: list[DimensionReport] = []
    for dim in dimensions:
        by_group: dict[str, set[str]] = {}
        for s in subjects:
            by_group.setdefault(demographics[s].values.get(dim, UNKNOWN), set()).add(s)
        shown: list[tuple[str, set[str]]] = []
        hidden_volunteers = 0
        for group in sorted(by_group):
            members = by_group[group]
            has_both = {p.kind for p in pairs if p.subject in members} >= {"genuine", "impostor"}
            if len(members) < min_group or not has_both:
                hidden_volunteers += len(members)
            else:
                shown.append((group, members))
        any_hidden = hidden_volunteers > 0
        shown.sort(key=lambda gm: len(gm[1]))
        while any_hidden and hidden_volunteers < min_group and shown:
            hidden_volunteers += len(shown.pop(0)[1])
        if any_hidden and hidden_volunteers < min_group:
            reports.append(DimensionReport(dim, (), True))
            continue
        rows: list[GroupRow] = []
        for group, members in sorted(shown):
            g = [p.score for p in pairs if p.subject in members and p.kind == "genuine"]
            i = [p.score for p in pairs if p.subject in members and p.kind == "impostor"]
            rows.append(GroupRow(group, size_band(len(members)), sweep(g, i, [threshold])[0]))
        reports.append(DimensionReport(dim, tuple(rows), any_hidden))
    return reports
