"""Keystroke analytics (FR-802, FR-608, TC-062, TC-073).

Input is the editor-model change stream recorded by the SDK (keystroke.ts), never raw key events.
Each detector returns evidence (`Finding`) with timestamp, duration, confidence and an excerpt;
humans decide. Detectors named in `IntegrityConfig.disabled_event_types` never run (FR-305).

Known blind spots and false-positive risks are listed in INTEGRITY-CONFIG.md and the red-team notes.
"""

from __future__ import annotations

import statistics
from collections import deque
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from worker.config import IntegrityConfig, KeystrokeConfig
from worker.events import (
    Finding,
    KeystrokeBatch,
    KeystrokeCursor,
    KeystrokeEdit,
    KeystrokeReset,
)

_MAX_DELETED_MEMORY_CHARS = 200_000


@dataclass(frozen=True, slots=True)
class TimelineEdit:
    ms: int  # monotonic epoch milliseconds (client clock, untrusted)
    text: str
    deleted: str
    counted: bool  # False for format-only and undo/redo edits


@dataclass(slots=True)
class Timeline:
    """Replayed editor timeline for one question."""

    session_question_id: str
    edits: list[TimelineEdit] = field(default_factory=list)
    activity_ms: list[int] = field(default_factory=list)  # every event, including cursor moves
    final_text: str = ""
    clock_regressions: int = 0
    out_of_range_edits: int = 0


@dataclass(frozen=True, slots=True)
class KeystrokeStats:
    inserted_chars: int
    deleted_chars: int
    deletion_ratio: float | None
    edit_count: int
    active_span_ms: int


@dataclass(frozen=True, slots=True)
class QuestionAnalysis:
    session_question_id: str
    findings: list[Finding]
    stats: KeystrokeStats
    final_text: str


def _normalize_ws(s: str) -> str:
    return "".join(s.split())


def build_timeline(batches: Sequence[KeystrokeBatch], cfg: KeystrokeConfig) -> Timeline:
    """Replay batches of ONE question in `seq` order (NFR-08: arrival order is not trusted).

    The same `seq` twice is a retry the API already de-duplicated; if one slips through, the first
    copy wins. Offsets outside the document are clamped and counted, never trusted.
    """
    if not batches:
        raise ValueError("At least one batch is required.")
    qid = batches[0].session_question_id
    tl = Timeline(session_question_id=qid)
    seen: set[int] = set()
    doc = ""
    last_ms = 0
    recent_deleted: deque[tuple[int, str]] = deque()
    recent_chars = 0
    for batch in sorted(batches, key=lambda b: b.seq):
        if batch.session_question_id != qid:
            raise ValueError("All batches must belong to one question.")
        if batch.seq in seen:
            continue
        seen.add(batch.seq)
        base = int(batch.started_at.timestamp() * 1000)
        for ev in batch.events:
            raw = base + ev.t
            ms = max(raw, last_ms)
            if raw < last_ms:
                tl.clock_regressions += 1
            last_ms = ms
            tl.activity_ms.append(ms)
            if isinstance(ev, KeystrokeReset):
                doc = ev.text
                continue
            if isinstance(ev, KeystrokeCursor):
                continue
            if not isinstance(ev, KeystrokeEdit):
                continue
            start = min(ev.offset, len(doc))
            end = min(start + ev.delete_length, len(doc))
            if ev.offset > len(doc) or ev.offset + ev.delete_length > len(doc):
                tl.out_of_range_edits += 1
            deleted = doc[start:end]
            doc = doc[:start] + ev.text + doc[end:]
            while recent_deleted and (
                recent_deleted[0][0] < ms - cfg.undo_memory_ms
                or recent_chars > _MAX_DELETED_MEMORY_CHARS
            ):
                recent_chars -= len(recent_deleted.popleft()[1])
            counted = bool(ev.text)
            if ev.text and deleted and _normalize_ws(ev.text) == _normalize_ws(deleted):
                counted = False  # formatter or re-indent: same code, different whitespace
            elif len(ev.text) >= cfg.undo_min_chars and any(
                ev.text == d for _, d in recent_deleted
            ):
                counted = False  # undo/redo restores text the candidate had just removed
            if len(deleted) >= cfg.undo_min_chars:
                recent_deleted.append((ms, deleted))
                recent_chars += len(deleted)
            tl.edits.append(TimelineEdit(ms=ms, text=ev.text, deleted=deleted, counted=counted))
    tl.final_text = doc
    return tl


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "..."


def detect_paste_bursts(tl: Timeline, cfg: KeystrokeConfig) -> list[Finding]:
    """PASTE_BURST: over `burst_min_chars` inserted within `burst_window_ms` (FR-802, TC-073)."""
    edits = tl.edits
    window: deque[int] = deque()  # indexes of counted edits inside the window
    window_chars = 0
    spans: list[list[int]] = []  # [lo_idx, hi_idx]
    for i, e in enumerate(edits):
        if not e.counted:
            continue
        window.append(i)
        window_chars += len(e.text)
        while edits[window[0]].ms <= e.ms - cfg.burst_window_ms:
            window_chars -= len(edits[window.popleft()].text)
        if window_chars > cfg.burst_min_chars:
            lo = window[0]
            if spans and lo <= spans[-1][1]:
                spans[-1][1] = i
            else:
                spans.append([lo, i])
    findings: list[Finding] = []
    for lo, hi in spans:
        part = [e for e in edits[lo : hi + 1] if e.counted]
        chars = sum(len(e.text) for e in part)
        duration = edits[hi].ms - edits[lo].ms
        ratio = chars / cfg.burst_min_chars
        confidence = min(1.0, 0.5 + 0.5 * min(1.0, (ratio - 1.0) / 3.0))
        findings.append(
            Finding(
                type="PASTE_BURST",
                occurred_at_ms=edits[lo].ms,
                duration_ms=duration,
                confidence=round(confidence, 3),
                payload={
                    "sessionQuestionId": tl.session_question_id,
                    "insertedChars": chars,
                    "windowMs": duration,
                },
                excerpt=_clip("".join(e.text for e in part), cfg.excerpt_max_chars),
                details={"edits": len(part)},
            )
        )
    return findings


def _typing_runs(tl: Timeline, cfg: KeystrokeConfig) -> list[list[tuple[TimelineEdit, bool]]]:
    """Runs of consecutive single-character inserts, split on pauses and other edits.

    Each edit carries a flag: True when it belongs to a stretch of one identical character
    (held key, indentation). Intervals inside such a stretch are not typing rhythm and are dropped
    by the caller, but the run stays connected so a bot cannot split it with indentation.
    """
    edits = tl.edits
    n = len(edits)
    repeat = [False] * n
    i = 0
    while i < n:
        j = i
        while (
            len(edits[i].text) == 1
            and j + 1 < n
            and edits[j + 1].text == edits[i].text
            and edits[j + 1].deleted == ""
        ):
            j += 1
        if len(edits[i].text) == 1 and j - i + 1 >= cfg.key_repeat_min_run:
            for k in range(i, j + 1):
                repeat[k] = True
        i = j + 1
    runs: list[list[tuple[TimelineEdit, bool]]] = []
    current: list[tuple[TimelineEdit, bool]] = []
    for idx, e in enumerate(edits):
        typed = len(e.text) == 1 and e.deleted == ""
        if not typed:
            if current:
                runs.append(current)
            current = []
            continue
        if current and e.ms - current[-1][0].ms > cfg.run_gap_ms:
            runs.append(current)
            current = []
        current.append((e, repeat[idx]))
    if current:
        runs.append(current)
    return runs


def detect_typing_anomalies(tl: Timeline, cfg: KeystrokeConfig) -> list[Finding]:
    """TYPING_ANOMALY: unnaturally regular or unnaturally fast single-character typing (FR-802)."""
    findings: list[Finding] = []
    for run in _typing_runs(tl, cfg):
        intervals = [
            b.ms - a.ms
            for (a, ra), (b, rb) in zip(run, run[1:], strict=False)
            if b.ms - a.ms >= 1 and not (ra and rb)
        ]
        if len(intervals) < cfg.regularity_min_samples:
            continue
        mean = statistics.fmean(intervals)
        cv = statistics.pstdev(intervals) / mean
        median = statistics.median(intervals)
        metrics: list[str] = []
        confidence = 0.0
        if cv < cfg.regularity_max_cv:
            metrics.append("interval_cv_low")
            confidence = max(confidence, 0.4 + 0.5 * (1.0 - cv / cfg.regularity_max_cv))
        if median < cfg.speed_max_median_interval_ms:
            metrics.append("speed_outlier")
            confidence = max(
                confidence, 0.5 + 0.4 * (1.0 - median / cfg.speed_max_median_interval_ms)
            )
        if not metrics:
            continue
        findings.append(
            Finding(
                type="TYPING_ANOMALY",
                occurred_at_ms=run[0][0].ms,
                duration_ms=run[-1][0].ms - run[0][0].ms,
                confidence=round(min(confidence, 1.0), 3),
                payload={
                    "sessionQuestionId": tl.session_question_id,
                    "metric": "+".join(metrics),
                },
                excerpt=_clip("".join(e.text for e, _ in run), cfg.excerpt_max_chars),
                details={
                    "samples": len(intervals),
                    "meanIntervalMs": round(mean, 2),
                    "medianIntervalMs": round(median, 2),
                    "intervalCv": round(cv, 4),
                },
            )
        )
    findings.sort(key=lambda f: f.confidence, reverse=True)
    top = findings[: cfg.max_typing_findings_per_question]
    return sorted(top, key=lambda f: f.occurred_at_ms)


def detect_deletion_ratio(
    tl: Timeline, stats: KeystrokeStats, cfg: KeystrokeConfig
) -> list[Finding]:
    """Optional: a large body of code written with almost no corrections. Off by default."""
    if (
        not cfg.deletion_ratio_enabled
        or stats.deletion_ratio is None
        or stats.inserted_chars < cfg.deletion_ratio_min_inserted
        or stats.deletion_ratio > cfg.deletion_ratio_max
        or not tl.edits
    ):
        return []
    return [
        Finding(
            type="TYPING_ANOMALY",
            occurred_at_ms=tl.edits[0].ms,
            duration_ms=tl.edits[-1].ms - tl.edits[0].ms,
            confidence=0.3,
            payload={"sessionQuestionId": tl.session_question_id, "metric": "deletion_ratio_low"},
            details={"deletionRatio": round(stats.deletion_ratio, 4)},
        )
    ]


def detect_idle_then_complete(tl: Timeline, cfg: KeystrokeConfig) -> list[Finding]:
    """IDLE_THEN_COMPLETE: long silence, then a whole solution appears quickly (FR-802)."""
    findings: list[Finding] = []
    times = tl.activity_ms
    edits = tl.edits
    for prev, cur in zip(times, times[1:], strict=False):
        gap = cur - prev
        if gap < cfg.idle_ms:
            continue
        window = [e for e in edits if cur <= e.ms <= cur + cfg.complete_window_ms and e.counted]
        chars = sum(len(e.text) for e in window)
        if chars < cfg.complete_min_chars:
            continue
        confidence = 0.4 + 0.3 * min(1.0, (chars / cfg.complete_min_chars - 1.0) / 4.0)
        if gap >= 2 * cfg.idle_ms:
            confidence += 0.2
        findings.append(
            Finding(
                type="IDLE_THEN_COMPLETE",
                occurred_at_ms=cur,
                duration_ms=window[-1].ms - cur,
                confidence=round(min(confidence, 1.0), 3),
                payload={
                    "sessionQuestionId": tl.session_question_id,
                    "idleMs": gap,
                    "insertedChars": chars,
                },
                excerpt=_clip("".join(e.text for e in window), cfg.excerpt_max_chars),
            )
        )
    return findings


def compute_stats(tl: Timeline) -> KeystrokeStats:
    inserted = sum(len(e.text) for e in tl.edits if e.counted)
    deleted = sum(len(e.deleted) for e in tl.edits)
    span = tl.activity_ms[-1] - tl.activity_ms[0] if tl.activity_ms else 0
    return KeystrokeStats(
        inserted_chars=inserted,
        deleted_chars=deleted,
        deletion_ratio=(deleted / inserted) if inserted else None,
        edit_count=len(tl.edits),
        active_span_ms=span,
    )


def analyze_question(
    batches: Sequence[KeystrokeBatch], config: IntegrityConfig | None = None
) -> QuestionAnalysis:
    cfg = config or IntegrityConfig()
    k = cfg.keystrokes
    tl = build_timeline(batches, k)
    stats = compute_stats(tl)
    findings: list[Finding] = []
    if cfg.is_enabled("PASTE_BURST"):
        findings += detect_paste_bursts(tl, k)
    if cfg.is_enabled("TYPING_ANOMALY"):
        findings += detect_typing_anomalies(tl, k)
        findings += detect_deletion_ratio(tl, stats, k)
    if cfg.is_enabled("IDLE_THEN_COMPLETE"):
        findings += detect_idle_then_complete(tl, k)
    findings.sort(key=lambda f: f.occurred_at_ms)
    return QuestionAnalysis(tl.session_question_id, findings, stats, tl.final_text)


def analyze_keystrokes(
    batches: Iterable[KeystrokeBatch], config: IntegrityConfig | None = None
) -> list[QuestionAnalysis]:
    """Group a session's batches by question and analyze each."""
    groups: dict[str, list[KeystrokeBatch]] = {}
    for b in batches:
        groups.setdefault(b.session_question_id, []).append(b)
    return [analyze_question(g, config) for g in groups.values()]
