from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest

from helpers import num, silence, tone
from worker.config import IntegrityConfig, VadConfig
from worker.vad import (
    EnergyVadBackend,
    SileroOnnxBackend,
    analyze_audio,
    estimate_f0,
    segments_from_probabilities,
)

VC = VadConfig()
SR = 16_000


def cat(*parts: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    return np.concatenate(parts).astype(np.float32)


class CountingBackend(EnergyVadBackend):
    calls = 0

    def speech_probabilities(self, samples, sample_rate):  # type: ignore[no-untyped-def]
        CountingBackend.calls += 1
        return super().speech_probabilities(samples, sample_rate)


def test_tc061_silence_produces_no_events() -> None:
    assert analyze_audio(silence(10), EnergyVadBackend()) == []


def test_tc061_sustained_speech_emits_speech_detected_with_duration() -> None:
    audio = cat(silence(2), tone(130, 4), silence(2))
    out = analyze_audio(audio, EnergyVadBackend(), audio_start_ms=1_000_000)
    speech = [f for f in out if f.type == "SPEECH_DETECTED"]
    assert len(speech) == 1
    assert abs(speech[0].duration_ms - 4000) < 150
    assert abs(speech[0].occurred_at_ms - (1_000_000 + 2000)) < 150
    assert 0.5 <= speech[0].confidence <= 1.0


def test_fr607_false_positive_short_cough_or_keyclick_is_not_an_event() -> None:
    audio = cat(silence(1), tone(150, 0.6), silence(3))
    assert analyze_audio(audio, EnergyVadBackend()) == []


def test_fr607_pause_inside_a_sentence_is_merged_into_one_segment() -> None:
    audio = cat(tone(130, 2), silence(0.3), tone(130, 2), silence(1))
    speech = [f for f in analyze_audio(audio, EnergyVadBackend()) if f.type == "SPEECH_DETECTED"]
    assert len(speech) == 1 and speech[0].duration_ms > 4000


def test_tc061_two_distinct_pitches_emit_multiple_voices_with_capped_confidence() -> None:
    audio = cat(tone(115, 4), silence(1), tone(210, 4), silence(1))
    multi = [f for f in analyze_audio(audio, EnergyVadBackend()) if f.type == "MULTIPLE_VOICES"]
    assert len(multi) == 1
    assert multi[0].confidence <= VC.speaker_max_confidence
    assert num(multi[0].details["pitchRatio"]) > 1.5
    assert multi[0].duration_ms > 8000


def test_fr607_false_positive_one_speaker_with_intonation_is_not_multiple_voices() -> None:
    audio = cat(tone(120, 4), silence(1), tone(138, 4), silence(1))  # ratio 1.15 < 1.3
    assert [
        f for f in analyze_audio(audio, EnergyVadBackend()) if f.type == "MULTIPLE_VOICES"
    ] == []


def test_fr607_second_voice_too_brief_is_not_enough_evidence() -> None:
    audio = cat(tone(115, 6), silence(1), tone(210, 1.5), silence(1))
    assert [
        f for f in analyze_audio(audio, EnergyVadBackend()) if f.type == "MULTIPLE_VOICES"
    ] == []


def test_fr607_known_blind_spot_two_speakers_with_same_pitch_not_detected() -> None:
    # Documented in the red-team notes: pitch cannot separate similar voices.
    audio = cat(tone(120, 4), silence(1), tone(122, 4), silence(1))
    assert [
        f for f in analyze_audio(audio, EnergyVadBackend()) if f.type == "MULTIPLE_VOICES"
    ] == []


def test_fr305_disabled_voice_detectors_never_call_the_model() -> None:
    CountingBackend.calls = 0
    cfg = IntegrityConfig(disabled_event_types=frozenset({"SPEECH_DETECTED", "MULTIPLE_VOICES"}))
    assert analyze_audio(tone(130, 4), CountingBackend(), cfg) == []
    assert CountingBackend.calls == 0


def test_fr305_disabling_only_multiple_voices_keeps_speech_events() -> None:
    cfg = IntegrityConfig(disabled_event_types=frozenset({"MULTIPLE_VOICES"}))
    audio = cat(tone(115, 4), silence(1), tone(210, 4))
    types = {f.type for f in analyze_audio(audio, EnergyVadBackend(), cfg)}
    assert types == {"SPEECH_DETECTED"}


def test_fr607_thresholds_are_configurable() -> None:
    cfg = IntegrityConfig.model_validate({"vad": {"minEventMs": 500}})
    audio = cat(silence(1), tone(150, 0.9), silence(1))
    assert [f.type for f in analyze_audio(audio, EnergyVadBackend(), cfg)] == ["SPEECH_DETECTED"]


def test_fr607_segments_from_probabilities_threshold_merge_and_drop_short() -> None:
    p = np.zeros(200, dtype=np.float32)
    p[10:40] = 0.9  # 960 ms
    p[45:60] = 0.9  # gap 5 frames = 160 ms -> merged
    p[100:105] = 0.9  # 160 ms -> dropped (< 250)
    p[150:200] = 0.4  # below threshold
    segs = segments_from_probabilities(p, VC)
    assert len(segs) == 1
    assert segs[0].start_ms == 320 and segs[0].end_ms == 1920


def test_fr607_segment_open_at_end_of_audio_is_closed() -> None:
    p = np.zeros(50, dtype=np.float32)
    p[10:] = 0.9
    assert len(segments_from_probabilities(p, VC)) == 1


@pytest.mark.parametrize("f0", [90.0, 120.0, 200.0, 280.0])
def test_fr607_pitch_estimate_is_accurate_within_five_percent(f0: float) -> None:
    frame = tone(f0, 0.04)
    est = estimate_f0(frame, SR, VC.f0_min_hz, VC.f0_max_hz)
    assert est is not None and abs(est - f0) / f0 < 0.05


def test_fr607_pitch_estimate_rejects_noise_and_quiet_audio() -> None:
    rng = np.random.default_rng(0)
    noise = (0.2 * rng.standard_normal(640)).astype(np.float32)
    assert estimate_f0(noise, SR, VC.f0_min_hz, VC.f0_max_hz) is None
    assert estimate_f0(silence(0.04), SR, VC.f0_min_hz, VC.f0_max_hz) is None


def test_fr607_silero_backend_refuses_unpinned_model_file(tmp_path: Path) -> None:
    fake = tmp_path / "silero_vad.onnx"
    fake.write_bytes(b"not the model")
    with pytest.raises(ValueError, match="pinned"):
        SileroOnnxBackend(fake)


def test_fr607_silero_integration_runs_when_model_is_provided() -> None:
    import os

    path = os.environ.get("SILERO_VAD_MODEL_PATH")
    if not path:
        pytest.skip("Set SILERO_VAD_MODEL_PATH to the pinned silero_vad.onnx to run (manual).")
    probs = SileroOnnxBackend(Path(path)).speech_probabilities(silence(1), SR)
    assert probs.max() < 0.5
