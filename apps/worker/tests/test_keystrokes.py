from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from helpers import QID, T0, batch, batches, cursor, edit, human_intervals, num, reset, typed
from worker import keystrokes
from worker.config import IntegrityConfig
from worker.events import Finding, KeystrokeBatch
from worker.keystrokes import analyze_keystrokes, analyze_question

CODE = "def solve(values):\n    total = 0\n    for v in values:\n        total += v\n    return total\n"


def findings(
    events: list[dict[str, Any]], cfg: IntegrityConfig | None = None, kind: str | None = None
) -> list[Finding]:
    fs = analyze_question(batches(events), cfg).findings
    return [f for f in fs if kind is None or f.type == kind]


# ---------- Contract (keystroke.ts mirror) ----------


def test_fr608_edit_must_change_code() -> None:
    with pytest.raises(ValidationError):
        batch([edit(0, "", delete=0)])


def test_fr608_events_must_be_time_ordered_and_unknown_keys_rejected() -> None:
    with pytest.raises(ValidationError):
        batch([edit(10, "a"), edit(5, "b")])
    with pytest.raises(ValidationError):
        KeystrokeBatch.model_validate(
            {
                "seq": 0,
                "sessionQuestionId": QID,
                "startedAt": T0,
                "events": [
                    {
                        "kind": "EDIT",
                        "t": 0,
                        "offset": 0,
                        "deleteLength": 0,
                        "text": "a",
                        "key": "a",
                    }
                ],
            }
        )


# ---------- Replay (FR-608, TC-062) ----------


def test_tc062_replay_reproduces_final_code_across_out_of_order_batches() -> None:
    first, _ = typed("abc", 0, [100])
    second = [edit(0, "XY", offset=3), edit(50, "", offset=0, delete=1)]
    b0 = batch(first, seq=0)
    b1 = batch(second, seq=1, started_at="2026-10-05T10:00:10Z")
    a = analyze_question([b1, b0])  # arrival order reversed (NFR-08)
    assert a.final_text == "bcXY"


def test_tc062_reset_replaces_document_and_duplicate_seq_is_ignored() -> None:
    b0 = batch([reset(0, "print(1)"), edit(10, "2", offset=6, delete=1)], seq=0)
    dup = batch([edit(0, "ZZZ", offset=0)], seq=0)
    assert analyze_question([b0, dup]).final_text == "print(2)"


def test_fr608_out_of_range_offsets_are_clamped_not_trusted() -> None:
    tl = keystrokes.build_timeline(
        [batch([edit(0, "abc", offset=9999), edit(5, "", offset=1, delete=500)])],
        IntegrityConfig().keystrokes,
    )
    assert tl.final_text == "a"
    assert tl.out_of_range_edits == 2


def test_fr608_client_clock_regression_is_clamped_monotonic() -> None:
    b0 = batch([edit(5000, "a")], seq=0, started_at="2026-10-05T10:00:10Z")
    b1 = batch([edit(0, "b", offset=1)], seq=1, started_at="2026-10-05T10:00:00Z")
    tl = keystrokes.build_timeline([b0, b1], IntegrityConfig().keystrokes)
    assert tl.clock_regressions == 1
    assert tl.edits[1].ms >= tl.edits[0].ms


def test_fr802_analyze_keystrokes_groups_by_question() -> None:
    q2 = "22222222-2222-4222-8222-222222222222"
    out = analyze_keystrokes([batch([edit(0, "a")]), batch([edit(0, "b")], qid=q2)])
    assert {a.session_question_id for a in out} == {QID, q2}


# ---------- PASTE_BURST (FR-802, TC-073) ----------


def test_tc073_auto_typed_300_chars_in_half_second_is_paste_burst() -> None:
    text = "x" * 300
    events = [edit(i * 5 // 3, text[i], offset=i) for i in range(300)]
    fs = findings(events, kind="PASTE_BURST")
    assert len(fs) == 1
    f = fs[0]
    assert f.payload["insertedChars"] == 300
    assert f.duration_ms <= 500
    assert f.confidence >= 0.9
    assert f.excerpt is not None and len(f.excerpt) <= 203


def test_tc073_single_edit_paste_is_burst_with_zero_duration() -> None:
    fs = findings([edit(100, "a" * 300)], kind="PASTE_BURST")
    assert len(fs) == 1 and fs[0].duration_ms == 0


def test_fr802_threshold_is_strictly_over_80_chars() -> None:
    assert findings([edit(0, "a" * 80)], kind="PASTE_BURST") == []
    assert len(findings([edit(0, "a" * 81)], kind="PASTE_BURST")) == 1


def test_fr802_threshold_is_configurable_per_org() -> None:
    cfg = IntegrityConfig.model_validate({"keystrokes": {"burstMinChars": 200}})
    assert findings([edit(0, "a" * 150)], cfg, kind="PASTE_BURST") == []
    assert len(findings([edit(0, "a" * 250)], cfg, kind="PASTE_BURST")) == 1


def test_fr802_chars_spread_over_more_than_window_are_not_a_burst() -> None:
    events = [edit(i * 100, "a" * 20, offset=i * 20) for i in range(10)]  # 200 chars in 900 ms
    assert len(findings(events, kind="PASTE_BURST")) == 1
    slow = [edit(i * 1200, "a" * 60, offset=i * 60) for i in range(5)]  # 60 chars per 1.2 s
    assert findings(slow, kind="PASTE_BURST") == []


def test_fr802_fast_typist_is_not_a_burst() -> None:
    # 120 wpm is about 10 chars per second; burst needs 80 per second.
    events, _ = typed(CODE * 3, 0, [90, 110, 70, 140, 95])
    assert findings(events, kind="PASTE_BURST") == []


def test_fr802_false_positive_ide_autocomplete_snippet_below_threshold() -> None:
    events = [edit(0, "for (int i = 0; i < n; i++) {\n    \n}", offset=0)]  # 36 chars
    assert findings(events, kind="PASTE_BURST") == []


def test_fr802_false_positive_format_document_is_not_a_paste() -> None:
    messy = "def f(a,b):\n  return a+b\n" * 6
    tidy = "def f(a, b):\n    return a + b\n" * 6
    events = [edit(0, messy), edit(5000, tidy, offset=0, delete=len(messy))]
    fs = findings(events, kind="PASTE_BURST")
    assert len(fs) == 1 and fs[0].payload["insertedChars"] == len(messy)  # the format is ignored


def test_fr802_false_positive_undo_redo_reinsertion_is_not_a_paste() -> None:
    block = "x = compute(values)\n" * 10  # 200 chars typed earlier
    events, t = typed(block, 0, [150], base_offset=0)
    events.append(edit(t + 1000, "", offset=0, delete=len(block)))  # undo removes it
    events.append(edit(t + 1500, block, offset=0))  # redo puts it back
    assert findings(events, kind="PASTE_BURST") == []


def test_fr802_false_positive_reset_on_restore_is_not_counted() -> None:
    assert findings([reset(0, "a" * 5000), edit(100, "b", offset=5000)], kind="PASTE_BURST") == []


def test_fr802_adjacent_detections_merge_into_one_finding() -> None:
    events = [edit(i * 50, "a" * 50, offset=i * 50) for i in range(20)]  # sustained flood
    assert len(findings(events, kind="PASTE_BURST")) == 1


# ---------- TYPING_ANOMALY (FR-802) ----------


def test_fr802_robotic_constant_interval_typing_is_flagged() -> None:
    events, _ = typed(CODE * 2, 0, [120, 121, 120, 119, 120])
    fs = findings(events, kind="TYPING_ANOMALY")
    assert len(fs) == 1
    assert "interval_cv_low" in str(fs[0].payload["metric"])
    assert fs[0].confidence >= 0.8
    assert num(fs[0].details["intervalCv"]) < 0.12


def test_fr802_superhuman_speed_is_flagged_even_with_jitter() -> None:
    jitter = [8, 15, 9, 22, 11, 19, 7, 25]
    events, _ = typed(CODE * 2, 0, jitter)
    fs = findings(events, kind="TYPING_ANOMALY")
    assert len(fs) == 1 and "speed_outlier" in str(fs[0].payload["metric"])


def test_fr802_human_rhythm_is_not_flagged() -> None:
    text = CODE * 3
    events, _ = typed(text, 0, human_intervals(len(text)))
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr802_false_positive_fast_typist_with_natural_variance_not_flagged() -> None:
    # 100 ms mean (10 cps, a very fast typist) with realistic spread.
    text = CODE * 3
    events, _ = typed(text, 0, human_intervals(len(text), mean_ms=100, seed=3))
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr802_false_positive_held_key_repeat_is_ignored() -> None:
    events, _ = typed("-" * 120, 0, [33])  # OS key repeat: same char, constant 33 ms
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr802_too_few_samples_is_not_judged() -> None:
    events, _ = typed("abcdefghij", 0, [100])
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr802_long_pauses_split_runs_so_thinking_time_does_not_count() -> None:
    events: list[dict[str, Any]] = []
    t = 0
    for chunk in range(6):
        part, t = typed("abcdefg", t, [100])
        events += [dict(e, offset=chunk * 7 + i) for i, e in enumerate(part)]
        t += 5000
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr305_false_positive_assistive_dwell_typing_flagged_unless_accommodated() -> None:
    # Switch or eye-gaze input types at a fixed dwell time: regular by construction.
    events, _ = typed(CODE * 2, 0, [600])
    assert len(findings(events, kind="TYPING_ANOMALY")) == 1
    accommodated = IntegrityConfig(disabled_event_types=frozenset({"TYPING_ANOMALY"}))
    assert findings(events, accommodated, kind="TYPING_ANOMALY") == []


def test_fr802_screen_reader_or_dictation_chunked_input_is_not_typing_anomaly() -> None:
    events = [edit(i * 400, "word ", offset=i * 5) for i in range(60)]  # speech to text
    assert findings(events, kind="TYPING_ANOMALY") == []


def test_fr802_typing_anomaly_findings_are_capped_per_question() -> None:
    events: list[dict[str, Any]] = []
    t = 0
    for run in range(6):
        part, t = typed(CODE * 2, t, [120])
        events += [dict(e, offset=run * 1000 + i) for i, e in enumerate(part)]
        t += 5000
    assert len(findings(events, kind="TYPING_ANOMALY")) == 3


def test_fr802_deletion_ratio_reported_and_flag_is_opt_in() -> None:
    events, _ = typed(CODE * 6, 0, human_intervals(len(CODE) * 6))
    a = analyze_question(batches(events))
    assert a.stats.deletion_ratio == 0.0
    assert [f for f in a.findings if f.payload.get("metric") == "deletion_ratio_low"] == []
    on = IntegrityConfig.model_validate({"keystrokes": {"deletionRatioEnabled": True}})
    flagged = [f for f in analyze_question(batches(events), on).findings]
    assert [f.payload["metric"] for f in flagged] == ["deletion_ratio_low"]
    assert flagged[0].confidence == 0.3


# ---------- IDLE_THEN_COMPLETE (FR-802) ----------


def _idle_events(gap_ms: int, interval: int, chars: int) -> list[dict[str, Any]]:
    head, t = typed("x = 1\n", 0, human_intervals(6, seed=1))
    tail, _ = typed("y" * chars, t + gap_ms, [interval], base_offset=6)
    return head + tail


def test_fr802_idle_then_fast_completion_is_flagged() -> None:
    fs = findings(_idle_events(6 * 60_000, 40, 300), kind="IDLE_THEN_COMPLETE")
    assert len(fs) == 1
    assert num(fs[0].payload["idleMs"]) >= 360_000
    assert num(fs[0].payload["insertedChars"]) >= 200
    assert 0.4 <= fs[0].confidence <= 1.0


def test_fr802_idle_then_normal_pace_typing_is_not_flagged() -> None:
    assert findings(_idle_events(6 * 60_000, 250, 300), kind="IDLE_THEN_COMPLETE") == []


def test_fr802_short_pause_is_not_idle() -> None:
    assert findings(_idle_events(60_000, 40, 300), kind="IDLE_THEN_COMPLETE") == []


def test_fr802_cursor_activity_during_pause_counts_as_activity() -> None:
    head, t = typed("x = 1\n", 0, [150])
    reading = [cursor(t + k * 60_000, offset=k) for k in range(1, 7)]
    tail, _ = typed("y" * 300, t + 6 * 60_000 + 61_000, [40], base_offset=6)
    assert findings(head + reading + tail, kind="IDLE_THEN_COMPLETE") == []


# ---------- Accommodations (FR-305) ----------


def test_fr305_disabled_detectors_never_run(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("detector must not run")

    for name in ("detect_paste_bursts", "detect_typing_anomalies", "detect_idle_then_complete"):
        monkeypatch.setattr(keystrokes, name, boom)
    cfg = IntegrityConfig(
        disabled_event_types=frozenset({"PASTE_BURST", "TYPING_ANOMALY", "IDLE_THEN_COMPLETE"})
    )
    a = analyze_question([batch([edit(0, "a" * 500)])], cfg)
    assert a.findings == []
    assert a.final_text == "a" * 500
