"""Render /docs/face-threshold-report.md from computed results. Totals and percentages only."""

from __future__ import annotations

from collections.abc import Sequence

from tools.int01.groups import MIN_GROUP, DimensionReport
from tools.int01.metrics import Recommendation, ThresholdPoint

MODEL = (
    "AuraFace `glintr100.onnx`, SHA-256 "
    "`a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60` (ADR 0001 section 12)"
)


def _pct(x: float, places: int = 3) -> str:
    return f"{x * 100:.{places}f}%"


def render(
    *,
    data_label: str,
    n_volunteers: int,
    points: Sequence[ThresholdPoint],
    rec: Recommendation,
    groups: Sequence[DimensionReport],
    synthetic: bool,
    unscored_genuine: int = 0,
    genuine_total: int = 0,
    dropped_impostor: int = 0,
) -> str:
    lines = ["# Face-match threshold report (INT-01)", ""]
    if synthetic:
        lines += [
            "> **SYNTHETIC DATA. Not a result.** Generated from random scores to exercise the "
            "tooling. Do not use any number here to set the threshold.",
            "",
        ]
    lines += [
        f"Data: {data_label}. Volunteers: {n_volunteers}. Model: {MODEL}.",
        "Decision rule: score >= threshold is MATCH; below goes to manual review. Nobody is "
        "rejected automatically (D-05, FR-403).",
        "",
        "## Recommendation",
        "",
    ]
    if rec.point is None:
        lines.append(f"No threshold recommended. {rec.reason}")
    else:
        p = rec.point
        lines += [
            f"Target false-match rate: {_pct(rec.target_fmr)} (95% upper bound).",
            f"Recommended threshold: **{p.threshold:.2f}**. {rec.reason}",
            f"- False-match rate: {_pct(p.fmr)} ({p.false_matches} of {p.n_impostor} impostor "
            f"pairs; 95% upper bound {_pct(p.fmr_upper95)}).",
            f"- Expected manual-review rate for genuine candidates: {_pct(p.fnmr)} "
            f"({p.false_non_matches} of {p.n_genuine}; 95% upper bound {_pct(p.fnmr_upper95)}).",
        ]
    lines += [
        "",
        "Failure to capture: "
        f"{unscored_genuine} of {genuine_total} genuine pairs could not be scored (no usable face "
        "or a model error). They would go to manual review in production, so they are counted in "
        f"the FNMR column. {dropped_impostor} impostor pairs could not be scored; they cannot be "
        "false matches and are left out of the FMR.",
        "",
        "Scope: the manual-review rate excludes liveness failures (liveness is a client signal and "
        "is assumed confirmed here), and the FMR covers zero-effort impostors only, not "
        "presentation attacks or morphs.",
        "",
        "Caveat: impostor pairs reuse the same volunteers, so pairs are not independent and the "
        "bounds understate the uncertainty. A target of 0.1% needs about 3,000 effectively "
        "independent impostor pairs even with zero false matches.",
        "",
        "## Rates across thresholds",
        "",
        "| Threshold | FMR | FMR 95% upper | FNMR (manual review) | FNMR 95% upper |",
        "|---|---|---|---|---|",
    ]
    for p in points:
        lines.append(
            f"| {p.threshold:.2f} | {_pct(p.fmr)} | {_pct(p.fmr_upper95)} | {_pct(p.fnmr)} | "
            f"{_pct(p.fnmr_upper95)} |"
        )
    lines += ["", "## Per-group results at the recommended threshold", ""]
    if rec.point is None or not groups:
        lines.append("Not produced (no recommended threshold, or no demographic data).")
    else:
        lines.append(
            "Shown on the volunteers' explicit consent (C-12); only volunteers who agreed to "
            f"group results are included. Groups under {MIN_GROUP} volunteers are hidden, with "
            "complementary suppression, and sizes are given as bands only."
        )
        for d in groups:
            lines += ["", f"### {d.dimension}", ""]
            if not d.rows:
                lines.append("Dimension withheld (C-12): no group met the minimum safely.")
                continue
            lines += [
                "| Group | Volunteers (band) | FMR | FNMR |",
                "|---|---|---|---|",
            ]
            for r in d.rows:
                fmr, fnmr = _pct(r.point.fmr, 1), _pct(r.point.fnmr, 1)
                lines.append(f"| {r.group} | {r.size_band} | {fmr} | {fnmr} |")
            if d.hidden:
                lines.append(
                    "\nSome groups are not shown: groups under "
                    f"{MIN_GROUP} volunteers, groups without both pair kinds, and the smallest "
                    "shown groups when needed so that a hidden group cannot be worked out."
                )
    lines += [
        "",
        "## Sign-off",
        "",
        "- [ ] Owner accepts the report (INT-01 done-when).",
        "- [ ] Threshold set in system configuration.",
        "- [ ] Demographic data deleted; deletion recorded (date, who).",
        "",
    ]
    return "\n".join(lines)
