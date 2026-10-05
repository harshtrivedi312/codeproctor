"""Synthetic data builders shared by the tests. No real candidate data anywhere."""

from __future__ import annotations

import random
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import numpy.typing as npt

from worker.events import KeystrokeBatch

QID = "11111111-1111-4111-8111-111111111111"
T0 = "2026-10-05T10:00:00Z"

RawEvent = dict[str, Any]


def edit(t: int, text: str, offset: int = 0, delete: int = 0) -> RawEvent:
    return {"kind": "EDIT", "t": t, "offset": offset, "deleteLength": delete, "text": text}


def cursor(t: int, offset: int = 0) -> RawEvent:
    return {"kind": "CURSOR", "t": t, "offset": offset}


def reset(t: int, text: str = "", language: str = "python") -> RawEvent:
    return {"kind": "RESET", "t": t, "language": language, "text": text}


def batch(
    events: Sequence[RawEvent],
    seq: int = 0,
    started_at: str = T0,
    qid: str = QID,
) -> KeystrokeBatch:
    return KeystrokeBatch.model_validate(
        {"seq": seq, "sessionQuestionId": qid, "startedAt": started_at, "events": list(events)}
    )


def typed(
    text: str, start_t: int, intervals: Sequence[int], base_offset: int = 0
) -> tuple[list[RawEvent], int]:
    """One single-character EDIT per char at the given intervals (cycled). Returns end time."""
    out: list[RawEvent] = []
    t = start_t
    for i, ch in enumerate(text):
        out.append(edit(t, ch, offset=base_offset + i))
        t += intervals[i % len(intervals)]
    return out, t


def human_intervals(n: int, mean_ms: int = 180, seed: int = 7) -> list[int]:
    """Log-normal human rhythm: CV around 0.5."""
    rng = random.Random(seed)
    return [max(20, int(rng.lognormvariate(float(np.log(mean_ms)), 0.5))) for _ in range(n)]


def tone(f0: float, seconds: float, sr: int = 16_000, amp: float = 0.3) -> npt.NDArray[np.float32]:
    """Voiced-speech stand-in: five harmonics of f0 with a gentle amplitude envelope."""
    t = np.arange(int(seconds * sr)) / sr
    sig = sum(np.sin(2 * np.pi * f0 * h * t) / h for h in range(1, 6))
    env = 0.8 + 0.2 * np.sin(2 * np.pi * 3 * t)
    return np.asarray(amp * sig * env / 2, dtype=np.float32)


def silence(seconds: float, sr: int = 16_000) -> npt.NDArray[np.float32]:
    return np.zeros(int(seconds * sr), dtype=np.float32)


def batches(events: Sequence[RawEvent], qid: str = QID, first_seq: int = 0) -> list[KeystrokeBatch]:
    """Split a long event list into valid batches (<= 500 events, <= 500 s each), as the SDK does."""
    base = datetime.fromisoformat(T0.replace("Z", "+00:00")).astimezone(UTC)
    out: list[KeystrokeBatch] = []
    chunk: list[RawEvent] = []
    origin = 0

    def flush() -> None:
        nonlocal chunk
        if chunk:
            start = (base + timedelta(milliseconds=origin)).isoformat().replace("+00:00", "Z")
            rebased = [dict(e, t=e["t"] - origin) for e in chunk]
            out.append(batch(rebased, seq=first_seq + len(out), started_at=start, qid=qid))
        chunk = []

    for e in events:
        if not chunk:
            origin = e["t"]
        elif len(chunk) >= 500 or e["t"] - origin > 500_000:
            flush()
            origin = e["t"]
        chunk.append(e)
    flush()
    return out


def num(v: object) -> float:
    assert isinstance(v, int | float)
    return float(v)
