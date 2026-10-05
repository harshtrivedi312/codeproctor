"""Voice activity wrapper (FR-607 server re-check, TC-061, architecture.md step 4).

`VadBackend` is the swappable model interface. The production backend is Silero VAD (MIT, ONNX,
CPU, ADR 0001 section 12); tests use a fake backend so no model file is needed. The wrapper turns
per-frame speech probabilities into segments, then into evidence:

- SPEECH_DETECTED for merged speech segments of at least `min_event_ms`;
- MULTIPLE_VOICES from a weak pitch-based speaker-change heuristic, confidence capped.

Audio is 16 kHz mono float32. Samples and object keys are never logged. Disabled detectors (FR-305)
never touch the backend.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
import numpy.typing as npt

from worker.config import IntegrityConfig, VadConfig
from worker.events import Finding

Samples = npt.NDArray[np.float32]

# ADR 0001 section 12: silero_vad.onnx, Silero VAD v6.2.3, MIT.
SILERO_MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"  # noqa: S105 (file hash, not a secret)


class VadBackend(Protocol):
    def speech_probabilities(self, samples: Samples, sample_rate: int) -> npt.NDArray[np.float32]:
        """One speech probability per `VadConfig.frame_samples` frame."""
        ...


class SileroOnnxBackend:
    """Silero VAD through onnxruntime on CPU. Requires the `vad` extra and the pinned model file.

    The model is loaded from a local path (downloaded and verified by deployment, never at request
    time). Not exercised by unit tests; see tests/test_vad.py for the opt-in integration test.
    """

    _CONTEXT = 64

    def __init__(self, model_path: Path, frame_samples: int = 512) -> None:
        digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
        if digest != SILERO_MODEL_SHA256:
            raise ValueError("Silero VAD model file does not match the pinned SHA-256.")
        import onnxruntime as ort  # imported lazily: optional dependency

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._frame = frame_samples

    def speech_probabilities(self, samples: Samples, sample_rate: int) -> npt.NDArray[np.float32]:
        if sample_rate != 16_000:
            raise ValueError("Silero backend expects 16 kHz audio.")
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros((1, self._CONTEXT), dtype=np.float32)
        sr = np.array(sample_rate, dtype=np.int64)
        probs: list[float] = []
        for start in range(0, len(samples) - self._frame + 1, self._frame):
            chunk = samples[start : start + self._frame].reshape(1, -1)
            x = np.concatenate([context, chunk], axis=1)
            out, state = self._session.run(None, {"input": x, "state": state, "sr": sr})
            context = x[:, -self._CONTEXT :]
            probs.append(float(np.asarray(out).reshape(-1)[0]))
        return np.asarray(probs, dtype=np.float32)


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    start_ms: int
    end_ms: int
    mean_probability: float

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def segments_from_probabilities(
    probs: npt.NDArray[np.float32], cfg: VadConfig
) -> list[SpeechSegment]:
    """Threshold, merge gaps shorter than `merge_gap_ms`, drop segments under `min_speech_ms`."""
    frame_ms = cfg.frame_samples * 1000 / cfg.sample_rate
    raw: list[tuple[int, int]] = []
    start: int | None = None
    for i, p in enumerate(probs):
        if p >= cfg.speech_threshold and start is None:
            start = i
        elif p < cfg.speech_threshold and start is not None:
            raw.append((start, i))
            start = None
    if start is not None:
        raw.append((start, len(probs)))
    merged: list[list[int]] = []
    for lo, hi in raw:
        if merged and (lo - merged[-1][1]) * frame_ms < cfg.merge_gap_ms:
            merged[-1][1] = hi
        else:
            merged.append([lo, hi])
    out: list[SpeechSegment] = []
    for lo, hi in merged:
        duration = (hi - lo) * frame_ms
        if duration >= cfg.min_speech_ms:
            out.append(
                SpeechSegment(
                    start_ms=round(lo * frame_ms),
                    end_ms=round(hi * frame_ms),
                    mean_probability=float(np.mean(probs[lo:hi])),
                )
            )
    return out


def estimate_f0(frame: Samples, sample_rate: int, f_min: int, f_max: int) -> float | None:
    """Autocorrelation pitch estimate for one voiced frame; None if unvoiced or too quiet."""
    x = frame - float(np.mean(frame))
    if float(np.sqrt(np.mean(x * x))) < 0.01:
        return None
    lag_min = sample_rate // f_max
    lag_max = min(sample_rate // f_min, len(x) - 1)
    if lag_max <= lag_min:
        return None
    ac = np.correlate(x, x, mode="full")[len(x) - 1 :]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lag = int(np.argmax(ac[lag_min : lag_max + 1])) + lag_min
    if ac[lag] < 0.5:
        return None  # weakly periodic: noise or fricative
    return sample_rate / lag


def segment_pitch(samples: Samples, seg: SpeechSegment, cfg: VadConfig) -> tuple[float, int] | None:
    """(median f0 in Hz, voiced milliseconds) for one segment, or None if no voiced frames."""
    sr = cfg.sample_rate
    window = int(0.04 * sr)
    hop = int(0.02 * sr)
    lo = seg.start_ms * sr // 1000
    hi = min(seg.end_ms * sr // 1000, len(samples))
    f0s: list[float] = []
    for s in range(lo, hi - window, hop):
        f0 = estimate_f0(samples[s : s + window], sr, cfg.f0_min_hz, cfg.f0_max_hz)
        if f0 is not None:
            f0s.append(f0)
    if not f0s:
        return None
    return float(np.median(f0s)), len(f0s) * 20


def detect_speaker_change(
    samples: Samples, segments: Sequence[SpeechSegment], cfg: VadConfig, audio_start_ms: int
) -> Finding | None:
    """Weak evidence of a second speaker: two pitch groups, each with enough voiced speech.

    Segments are grouped by median f0; if the groups differ by more than `speaker_pitch_ratio`
    and both hold at least `speaker_min_cluster_ms` of speech, emit MULTIPLE_VOICES with
    confidence capped at `speaker_max_confidence`. Pitch is a poor speaker identity cue: one
    person changing tone, a TV, or two people with similar pitch all defeat it.
    """
    pitched: list[tuple[SpeechSegment, float, int]] = []
    for seg in segments:
        res = segment_pitch(samples, seg, cfg)
        if res is not None and res[1] >= cfg.speaker_min_voiced_ms // 4:
            pitched.append((seg, res[0], res[1]))
    if len(pitched) < 2:
        return None
    pitched.sort(key=lambda p: p[1])
    # Split at the largest relative pitch gap between neighbours.
    gaps = [(pitched[i + 1][1] / pitched[i][1], i) for i in range(len(pitched) - 1)]
    ratio, cut = max(gaps)
    if ratio < cfg.speaker_pitch_ratio:
        return None
    low, high = pitched[: cut + 1], pitched[cut + 1 :]
    if (
        sum(p[0].duration_ms for p in low) < cfg.speaker_min_cluster_ms
        or sum(p[0].duration_ms for p in high) < cfg.speaker_min_cluster_ms
    ):
        return None
    first = min(p[0].start_ms for p in pitched)
    last = max(p[0].end_ms for p in pitched)
    confidence = min(cfg.speaker_max_confidence, 0.3 + 0.3 * min(1.0, (ratio - 1.0) / 0.6))
    return Finding(
        type="MULTIPLE_VOICES",
        occurred_at_ms=audio_start_ms + first,
        duration_ms=last - first,
        confidence=round(confidence, 3),
        payload={},
        details={
            "pitchRatio": round(ratio, 3),
            "lowPitchHz": round(float(np.median([p[1] for p in low])), 1),
            "highPitchHz": round(float(np.median([p[1] for p in high])), 1),
        },
    )


def analyze_audio(
    samples: Samples,
    backend: VadBackend,
    config: IntegrityConfig | None = None,
    audio_start_ms: int = 0,
) -> list[Finding]:
    """Run VAD over one audio buffer and return SPEECH_DETECTED / MULTIPLE_VOICES evidence."""
    cfg = config or IntegrityConfig()
    v = cfg.vad
    want_speech = cfg.is_enabled("SPEECH_DETECTED")
    want_multi = cfg.is_enabled("MULTIPLE_VOICES")
    if not (want_speech or want_multi):
        return []  # accommodation: the model never runs (FR-305)
    probs = backend.speech_probabilities(samples, v.sample_rate)
    segments = segments_from_probabilities(probs, v)
    findings: list[Finding] = []
    if want_speech:
        for seg in segments:
            if seg.duration_ms >= v.min_event_ms:
                findings.append(
                    Finding(
                        type="SPEECH_DETECTED",
                        occurred_at_ms=audio_start_ms + seg.start_ms,
                        duration_ms=seg.duration_ms,
                        confidence=round(min(1.0, seg.mean_probability), 3),
                        payload={},
                    )
                )
    if want_multi:
        multi = detect_speaker_change(samples, segments, v, audio_start_ms)
        if multi is not None:
            findings.append(multi)
    findings.sort(key=lambda f: f.occurred_at_ms)
    return findings


class EnergyVadBackend:
    """RMS-energy stand-in for tests and local development. Not for production decisions."""

    def __init__(self, frame_samples: int = 512, rms_threshold: float = 0.02) -> None:
        self._frame = frame_samples
        self._thr = rms_threshold

    def speech_probabilities(self, samples: Samples, sample_rate: int) -> npt.NDArray[np.float32]:
        n = len(samples) // self._frame
        frames = samples[: n * self._frame].reshape(n, self._frame)
        rms = np.sqrt(np.mean(frames * frames, axis=1))
        return np.where(rms >= self._thr, 0.9, 0.05).astype(np.float32)
