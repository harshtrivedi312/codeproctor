"""The Python mirror must match packages/shared (events.ts, keystroke.ts, code-run.ts)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from worker import events as ev

SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src"

pytestmark = pytest.mark.skipif(not SHARED.exists(), reason="packages/shared not present")


def _read(name: str) -> str:
    return (SHARED / name).read_text()


def _const_array(src: str, name: str) -> list[str]:
    m = re.search(rf"export const {name}\s*(?::[^=]+)?=\s*\[(.*?)\]", src, re.DOTALL)
    assert m, name
    return re.findall(r"'([A-Z_a-z]+)'", m.group(1))


def _num(src: str, name: str) -> int:
    m = re.search(rf"export const {name}\s*=\s*([\d_]+)", src)
    assert m, name
    return int(m.group(1).replace("_", ""))


def test_fr801_event_types_match_shared() -> None:
    assert list(ev.DEFAULT_EVENT_SEVERITY) == _const_array(_read("events.ts"), "EVENT_TYPES")


def test_fr801_default_severity_matches_shared() -> None:
    src = _read("events.ts")
    block = re.search(r"DEFAULT_EVENT_SEVERITY[^=]*=\s*\{(.*?)\};", src, re.DOTALL)
    assert block
    pairs = dict(re.findall(r"([A-Z_]+):\s*'(LOW|MEDIUM|HIGH)'", block.group(1)))
    assert pairs == ev.DEFAULT_EVENT_SEVERITY


def test_fr804_zero_weight_and_points_match_shared() -> None:
    src = _read("events.ts")
    assert set(_const_array(src, "ZERO_WEIGHT_EVENT_TYPES")) == set(ev.ZERO_WEIGHT_EVENT_TYPES)
    pts = re.search(r"DEFAULT_SEVERITY_POINTS[^=]*=\s*\{(.*?)\};", src, re.DOTALL)
    assert pts
    parsed = {k: float(v) for k, v in re.findall(r"(LOW|MEDIUM|HIGH):\s*(\d+)", pts.group(1))}
    assert parsed == ev.DEFAULT_SEVERITY_POINTS
    assert _num(src, "DEFAULT_EVENT_CAP_PER_TYPE") == ev.DEFAULT_EVENT_CAP_PER_TYPE
    mins = re.search(r"RISK_BAND_MIN_SCORE[^=]*=\s*\{(.*?)\};", src, re.DOTALL)
    assert mins
    bands = {k: int(v) for k, v in re.findall(r"(LOW|MEDIUM|HIGH):\s*(\d+)", mins.group(1))}
    assert bands["MEDIUM"] == ev.DEFAULT_MEDIUM_MIN_SCORE
    assert bands["HIGH"] == ev.DEFAULT_HIGH_MIN_SCORE


def test_fr608_keystroke_limits_match_shared() -> None:
    ks = _read("keystroke.ts")
    assert _num(ks, "MAX_KEYSTROKE_EVENTS_PER_BATCH") == ev.MAX_KEYSTROKE_EVENTS_PER_BATCH
    assert _num(ks, "MAX_KEYSTROKE_OFFSET_MS") == ev.MAX_KEYSTROKE_OFFSET_MS
    assert _num(_read("code-run.ts"), "MAX_SOURCE_CODE_LENGTH") == ev.MAX_SOURCE_CODE_LENGTH
    assert _num(_read("events.ts"), "MAX_BATCH_SEQ") == ev.MAX_BATCH_SEQ


def test_fr608_code_languages_match_shared() -> None:
    langs = _const_array(_read("code-run.ts"), "CODE_LANGUAGES")
    assert set(langs) == {"python", "javascript", "java"}


def test_fr801_event_type_literal_matches_defaults() -> None:
    from typing import get_args

    assert list(get_args(ev.EventType)) == list(ev.DEFAULT_EVENT_SEVERITY)
