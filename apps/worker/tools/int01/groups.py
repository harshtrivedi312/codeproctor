"""Per-group breakdown with small groups suppressed (C-12, volunteer form sections 3 and 9).

- Only volunteers who ticked box C (`consent_group_results`) are counted in any group. Everyone
  else stays in the overall totals only.
- A rate is shown only if at least `min_group` volunteers contribute to it: for FNMR, volunteers
  with a genuine pair; for FMR, volunteers with an impostor pair (a failed ID intake leaves a
  volunteer with no genuine pairs).
- Complementary suppression: the overall totals count everyone in the scores file, so the
  residual (everyone not in a shown group: hidden groups, non-consenters, volunteers without
  demographics) must be empty or have at least `min_group` contributors for each pair kind.
  Otherwise the smallest shown groups are hidden until it does, and if that fails the whole
  dimension is withheld. Otherwise subtracting shown groups from the totals would expose an
  individual's result.
- Exact group sizes are never printed, only size bands. An impostor pair counts toward its
  probe's group only; the reference volunteer's demographics are not used.
- One dimension per report. Cells from two dimensions can be differenced against each other
  (for example two splits that differ by one volunteer), so a report covers exactly one
  dimension and `group_report` refuses a second. Do not publish reports for several dimensions
  from the same data without a new decision (FU-INB-07).
- Group rates are printed to one decimal place, so group sizes cannot be recovered from them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tools.int01.metrics import ThresholdPoint, sweep

MIN_GROUP = 10
UNKNOWN = "prefer not to say"
CONSENT_KEY = "consent_group_results"
ALLOWED_DIMENSIONS = frozenset({"age_band", "gender", "skin_tone", "glasses"})  # form section 2
_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 +/.\-]{0,23}$")


@dataclass(frozen=True, slots=True)
class ScoredPair:
    subject: str  # random volunteer code, never a name; not written to the report
    kind: str  # "genuine" or "impostor"
    score: float
    unscored: bool = False  # no score could be computed (capture failure); see score_pairs
    missing: bool = False  # an image file could not be read (a manifest error), left out entirely


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
        if key not in ALLOWED_DIMENSIONS:
            raise ValueError("unknown demographic dimension")
        if not isinstance(val, str) or not (val == UNKNOWN or _VALUE.match(val)):
            raise ValueError("invalid demographic value")
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


def _residual_ok(
    contrib_all: Mapping[str, set[str]],
    contrib: Mapping[str, Mapping[str, set[str]]],
    shown: set[str],
    min_group: int,
) -> bool:
    for k, everyone in contrib_all.items():
        rest = everyone.difference(*(contrib[g][k] for g in shown))
        if 0 < len(rest) < min_group:
            return False
    return True


def group_report(
    pairs: Sequence[ScoredPair],
    demographics: Mapping[str, SubjectDemo],
    threshold: float,
    dimension: str,
    min_group: int = MIN_GROUP,
) -> list[DimensionReport]:
    if min_group < MIN_GROUP:
        raise ValueError(f"min_group must be at least {MIN_GROUP} (C-12)")
    if dimension not in ALLOWED_DIMENSIONS:
        raise ValueError("unknown demographic dimension")
    eligible = {s for s, d in demographics.items() if d.consent_group_results}
    kinds = ("genuine", "impostor")
    contrib_all = {k: {p.subject for p in pairs if p.kind == k} for k in kinds}
    scored_eligible = eligible & {p.subject for p in pairs}
    dimensions = (
        [dimension] if any(dimension in demographics[s].values for s in scored_eligible) else []
    )
    reports: list[DimensionReport] = []
    for dim in dimensions:
        by_group: dict[str, set[str]] = {}
        for s in scored_eligible:
            by_group.setdefault(demographics[s].values.get(dim, UNKNOWN), set()).add(s)
        # group -> kind -> contributing volunteers
        contrib = {g: {k: m & contrib_all[k] for k in kinds} for g, m in by_group.items()}
        shown = {g for g, c in contrib.items() if all(len(c[k]) >= min_group for k in kinds)}

        while shown and not _residual_ok(contrib_all, contrib, shown, min_group):
            shown.discard(min(sorted(shown), key=lambda g: min(len(contrib[g][k]) for k in kinds)))
        rows: list[GroupRow] = []
        for group in sorted(shown):
            members = by_group[group]
            g = [p.score for p in pairs if p.subject in members and p.kind == "genuine"]
            i = [p.score for p in pairs if p.subject in members and p.kind == "impostor"]
            rows.append(GroupRow(group, size_band(len(members)), sweep(g, i, [threshold])[0]))
        reports.append(DimensionReport(dim, tuple(rows), len(shown) < len(by_group)))
    return reports
