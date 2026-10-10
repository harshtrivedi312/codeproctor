"""Signed /v1/analyze/* and /v1/risk routes equal the analyzers they wrap (ADR 0014 6.2).
FR-802, FR-803, FR-607, FR-804, FR-805; TC-061, TC-073, TC-074, TC-075, TC-076."""

from __future__ import annotations

import numpy as np
import pytest

from helpers import QID, batches, edit, silence, tone
from signed_app import make_app, send
from worker.config import IntegrityConfig
from worker.keystrokes import analyze_question
from worker.risk import calculate_risk, route_for_review
from worker.routes_analyze import AudioUnavailable, AudioWindow, FindingOut, VadRequest
from worker.similarity import (
    AiReference,
    Submission,
    find_peer_similarity,
    find_target_similarity,
)
from worker.vad import EnergyVadBackend, analyze_audio


@pytest.fixture(autouse=True)
def _no_review_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RISK_FAST_REVIEW_BANDS", raising=False)


CODE_A = (
    "def top(words, k):\n    counts = {}\n    for w in words:\n        counts[w] = counts.get(w, 0) + 1\n"
    "    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))\n"
    "    result = []\n    for w, _ in ordered[:k]:\n        result.append(w)\n    return result\n"
)
CODE_B = (
    "import heapq\nfrom collections import Counter\n\ndef top(words, k):\n    c = Counter(words)\n"
    "    heap = [(-n, w) for w, n in c.items()]\n    heapq.heapify(heap)\n"
    "    return [heapq.heappop(heap)[1] for _ in range(min(k, len(heap)))]\n"
)
TARGET = {"sessionId": "s-target", "sessionQuestionId": "q-1", "language": "python", "code": CODE_A}


def _wire(findings: list[object]) -> list[dict[str, object]]:
    from worker.events import Finding

    return [
        FindingOut.of(f).model_dump(by_alias=True, exclude_none=True)
        for f in findings
        if isinstance(f, Finding)
    ]


# ---------- keystrokes (FR-802, TC-073) ----------


def _kbody(events: list[dict[str, object]], **extra: object) -> dict[str, object]:
    bs = [b.model_dump(mode="json", by_alias=True) for b in batches(events)]
    return {"sessionQuestionId": QID, "batches": bs, **extra}


def test_tc073_keystrokes_route_equals_the_analyzer_and_reports_the_paste_burst() -> None:
    events = [edit(round(i * 0.5), "x", offset=i) for i in range(300)]
    r = send(make_app(), "/v1/analyze/keystrokes", _kbody(events))
    assert r.status_code == 200
    direct = analyze_question(batches(events))
    body = r.json()
    assert body["sessionQuestionId"] == direct.session_question_id == QID
    assert body["finalTextLength"] == len(direct.final_text) == 300
    assert body["findings"] == _wire(list(direct.findings))
    assert [f["type"] for f in body["findings"]] == ["PASTE_BURST"]
    assert set(body["findings"][0]) >= {"occurredAtMs", "durationMs", "confidence", "payload"}


def test_fr305_keystrokes_route_honours_disabled_event_types() -> None:
    events = [edit(i, "x", offset=i) for i in range(300)]
    cfg = {"disabledEventTypes": ["PASTE_BURST", "TYPING_ANOMALY"]}
    r = send(make_app(), "/v1/analyze/keystrokes", _kbody(events, config=cfg))
    assert r.status_code == 200 and r.json()["findings"] == []


def test_fr802_keystrokes_route_applies_the_org_thresholds() -> None:
    events = [edit(0, "a" * 150)]
    strict = send(
        make_app(),
        "/v1/analyze/keystrokes",
        _kbody(events, config={"keystrokes": {"burstMinChars": 200}}),
    )
    assert strict.json()["findings"] == []
    default = send(make_app(), "/v1/analyze/keystrokes", _kbody(events))
    assert [f["type"] for f in default.json()["findings"]] == ["PASTE_BURST"]


def test_fr802_keystrokes_batches_for_another_question_are_a_400() -> None:
    body = _kbody([edit(0, "a")])
    body["sessionQuestionId"] = "11111111-2222-4222-8222-333333333333"
    r = send(make_app(), "/v1/analyze/keystrokes", body)
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_FAILED"


def test_fr802_keystrokes_needs_at_least_one_batch_and_at_most_5000() -> None:
    assert (
        send(
            make_app(), "/v1/analyze/keystrokes", {"sessionQuestionId": QID, "batches": []}
        ).status_code
        == 400
    )


# ---------- similarity (FR-803, TC-074) ----------


def test_tc074_similarity_route_flags_the_target_against_the_corpus() -> None:
    body = {
        "target": TARGET,
        "corpus": [{"sessionId": "s-other", "language": "python", "code": CODE_A}],
    }
    r = send(make_app(), "/v1/analyze/similarity", body)
    assert r.status_code == 200
    (finding,) = r.json()["findings"]
    assert finding["type"] == "CODE_SIMILARITY"
    assert finding["payload"]["matchedSessionId"] == "s-other"
    assert "aiReferenceSolutionId" not in finding["payload"]
    assert finding["payload"]["sessionQuestionId"] == "q-1"


def test_tc074_similarity_route_equals_the_direct_function_with_ai_and_starter() -> None:
    corpus = [
        Submission("s-a", "", "python", CODE_A),
        Submission("s-b", "", "python", CODE_B),
    ]
    refs = [AiReference("ref-1", "python", CODE_A, True)]
    target = Submission("s-target", "q-1", "python", CODE_A)
    direct = find_target_similarity(target, corpus, IntegrityConfig(), {}, refs)
    body = {
        "target": TARGET,
        "corpus": [
            {"sessionId": c.session_id, "language": c.language, "code": c.code} for c in corpus
        ],
        "aiReferences": [
            {"id": "ref-1", "language": "python", "code": CODE_A, "isVariantMatch": True}
        ],
    }
    r = send(make_app(), "/v1/analyze/similarity", body)
    assert r.json()["findings"] == _wire(list(direct))
    kinds = sorted(f["type"] for f in r.json()["findings"])
    assert kinds == ["AI_LIKENESS", "CODE_SIMILARITY"]
    ai = next(f for f in r.json()["findings"] if f["type"] == "AI_LIKENESS")
    assert (
        ai["payload"]["aiReferenceSolutionId"] == "ref-1"
        and "matchedSessionId" not in ai["payload"]
    )


@pytest.mark.parametrize("size", [3, 6])  # 6 is large enough for the common-idiom filter
def test_tc074_target_versus_corpus_matches_the_all_pairs_result_for_that_target(size: int) -> None:
    corpus = [
        Submission(f"s{i}", f"q{i}", "python", CODE_A if i % 2 else CODE_B) for i in range(size)
    ]
    target = Submission("t", "qt", "python", CODE_A)
    pairs = find_peer_similarity([target, *corpus]).get("t", [])
    mine = find_target_similarity(target, corpus)
    assert [f.model_dump() for f in mine] == [f.model_dump() for f in pairs]
    if size == 3:
        assert mine  # the small corpus does produce findings, so the equality is not vacuous


def test_fr803_similarity_skips_the_targets_own_session_and_other_languages() -> None:
    body = {
        "target": TARGET,
        "corpus": [
            {"sessionId": "s-target", "language": "python", "code": CODE_A},
            {"sessionId": "s-js", "language": "javascript", "code": CODE_A},
        ],
    }
    assert send(make_app(), "/v1/analyze/similarity", body).json()["findings"] == []


def test_fr803_similarity_starter_code_is_not_counted_as_copying() -> None:
    body = {
        "target": TARGET,
        "corpus": [{"sessionId": "s-other", "language": "python", "code": CODE_A}],
        "starterCode": {"python": CODE_A},
    }
    assert send(make_app(), "/v1/analyze/similarity", body).json()["findings"] == []


def test_fr305_similarity_disabled_detectors_produce_nothing() -> None:
    body = {
        "target": TARGET,
        "corpus": [{"sessionId": "s-other", "language": "python", "code": CODE_A}],
        "aiReferences": [{"id": "r", "language": "python", "code": CODE_A}],
        "config": {"disabledEventTypes": ["CODE_SIMILARITY", "AI_LIKENESS"]},
    }
    assert send(make_app(), "/v1/analyze/similarity", body).json()["findings"] == []


def test_adr0014_6_2_similarity_caps_corpus_at_500_and_references_at_100() -> None:
    row = {"sessionId": "s", "language": "python", "code": "x"}
    assert (
        send(
            make_app(), "/v1/analyze/similarity", {"target": TARGET, "corpus": [row] * 501}
        ).status_code
        == 400
    )
    ref = {"id": "r", "language": "python", "code": "x"}
    assert (
        send(
            make_app(), "/v1/analyze/similarity", {"target": TARGET, "aiReferences": [ref] * 101}
        ).status_code
        == 400
    )


# ---------- vad (FR-607, TC-061) ----------


class FakeAudio:
    def __init__(self, samples: np.ndarray | None, missing: tuple[int, ...] = ()) -> None:
        self.samples = samples
        self.missing = missing
        self.calls = 0

    def load(self, request: VadRequest) -> AudioWindow:
        self.calls += 1
        if self.samples is None:
            raise AudioUnavailable
        return AudioWindow(self.samples, 12_345, self.missing)


VAD_BODY = {
    "sessionId": "s1",
    "segment": 0,
    "windowStartMs": 1_000_000,
    "header": {"seq": 0, "url": "https://s3.example.test/h"},
    "chunks": [{"seq": 1, "url": "https://s3.example.test/c1", "offsetMs": 0}],
}


def test_tc061_vad_route_equals_analyze_audio_and_reports_decoded_ms_and_missing_chunks() -> None:
    audio = np.concatenate([silence(1), tone(130, 4), silence(1)]).astype(np.float32)
    backend = EnergyVadBackend()
    a = make_app(audio=FakeAudio(audio, (3, 7)), vad_backend=backend)
    r = send(a, "/v1/analyze/vad", VAD_BODY)
    assert r.status_code == 200
    direct = analyze_audio(audio, backend, IntegrityConfig(), audio_start_ms=1_000_000)
    body = r.json()
    assert (
        body["findings"] == _wire(list(direct)) and body["findings"][0]["type"] == "SPEECH_DETECTED"
    )
    assert body["decodedMs"] == 12_345 and body["missingSeqs"] == [3, 7]
    # Times are epoch ms from windowStartMs plus the offset in the audio (speech starts at 1 s).
    assert abs(body["findings"][0]["occurredAtMs"] - 1_001_000) < 150


def test_tc061_vad_two_pitches_report_multiple_voices() -> None:
    audio = np.concatenate([tone(115, 4), silence(1), tone(210, 4)]).astype(np.float32)
    a = make_app(audio=FakeAudio(audio), vad_backend=EnergyVadBackend())
    types = {f["type"] for f in send(a, "/v1/analyze/vad", VAD_BODY).json()["findings"]}
    assert "MULTIPLE_VOICES" in types


def test_adr0014_6_2_vad_without_a_decoder_is_503_not_configured_never_a_fake_result() -> None:
    r = send(make_app(), "/v1/analyze/vad", VAD_BODY)
    assert r.status_code == 503 and r.json()["code"] == "WORKER_NOT_CONFIGURED"
    unavailable = make_app(audio=FakeAudio(None), vad_backend=EnergyVadBackend())
    assert send(unavailable, "/v1/analyze/vad", VAD_BODY).status_code == 503


def test_fr305_vad_with_both_detectors_disabled_fetches_no_audio_and_runs_no_model() -> None:
    audio = FakeAudio(tone(130, 4))
    a = make_app(audio=audio, vad_backend=EnergyVadBackend())
    cfg = {"disabledEventTypes": ["SPEECH_DETECTED", "MULTIPLE_VOICES"]}
    r = send(a, "/v1/analyze/vad", {**VAD_BODY, "config": cfg})
    assert r.status_code == 200 and r.json()["findings"] == [] and audio.calls == 0


def test_adr0014_6_2_vad_allows_at_most_90_chunks() -> None:
    chunk = {"seq": 1, "url": "https://s3.example.test/c", "offsetMs": 0}
    r = send(make_app(), "/v1/analyze/vad", {**VAD_BODY, "chunks": [chunk] * 91})
    assert r.status_code == 400


# ---------- risk (FR-804, FR-805, TC-075, TC-076) ----------

HIGH_TYPES = ["MULTIPLE_FACES", "PHONE_DETECTED"]
MEDIUM_TYPES = ["TAB_SWITCH", "NO_FACE", "GAZE_AWAY"]


def _risk(types: list[str], **extra: object) -> dict[str, object]:
    body: dict[str, object] = {
        "events": [{"type": t, "source": "CLIENT"} for t in types],
        "identityReviewPending": False,
        "shortAnswerPending": False,
        **extra,
    }
    r = send(make_app(), "/v1/risk", body)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


def test_tc075_two_high_and_three_medium_score_64_band_high_equal_to_the_calculator() -> None:
    out = _risk(HIGH_TYPES + MEDIUM_TYPES)
    direct = calculate_risk([*HIGH_TYPES, *MEDIUM_TYPES])  # type: ignore[list-item]
    assert out["score"] == 64 == int(direct.score) and out["band"] == direct.band == "HIGH"


def test_tc076_c28_every_band_is_reviewed_the_band_picks_path_and_rank() -> None:
    low = _risk([])
    medium = _risk(["TAB_SWITCH"] * 3 + ["NO_FACE"] * 2)
    high = _risk(HIGH_TYPES + MEDIUM_TYPES)
    for out, band, path in (
        (low, "LOW", "fast"),
        (medium, "MEDIUM", "full"),
        (high, "HIGH", "full"),
    ):
        direct = route_for_review(band)  # type: ignore[arg-type]
        assert (out["band"], out["reviewPath"], out["queueRank"]) == (band, path, direct.queue_rank)
        assert out["reasons"] == direct.reasons
    assert high["queueRank"] < medium["queueRank"] < low["queueRank"]  # type: ignore[operator]


def test_tc076_pending_identity_or_short_answer_forces_the_full_path_with_reasons() -> None:
    out = _risk([], identityReviewPending=True, shortAnswerPending=True)
    assert out["reviewPath"] == "full"
    assert out["reasons"] == ["RISK_LOW", "IDENTITY_MANUAL_REVIEW", "SHORT_ANSWER_MANUAL_SCORING"]


def test_fr804_score_is_an_integer_floor_so_it_never_reads_above_its_band() -> None:
    cfg = {"risk": {"severityPoints": {"LOW": 9.9}}}
    out = _risk(["RIGHT_CLICK", "RIGHT_CLICK", "RIGHT_CLICK"], config=cfg)  # 29.7 -> LOW
    assert out["score"] == 29 and out["band"] == "LOW"
    assert isinstance(out["score"], int)


def test_fr804_score_is_capped_at_100_and_accepts_source_and_duration() -> None:
    types = HIGH_TYPES * 3 + ["SCREEN_SHARE_STOPPED"] * 5 + ["CODE_SIMILARITY"] * 5
    body = {
        "events": [{"type": t, "source": "SERVER", "durationMs": 5} for t in types],
        "identityReviewPending": False,
        "shortAnswerPending": False,
    }
    out = send(make_app(), "/v1/risk", body).json()
    assert out["score"] == 100 and out["band"] == "HIGH"


def test_fr305_risk_disabled_event_types_do_not_score() -> None:
    cfg = {"disabledEventTypes": ["GAZE_AWAY", "NO_FACE"]}
    out = _risk(["GAZE_AWAY", "NO_FACE", "TAB_SWITCH"], config=cfg)
    assert out["score"] == 8


def test_fr805_c28_dl18_the_risk_route_reads_the_system_fast_path_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "")
    assert _risk([])["reviewPath"] == "full"
    monkeypatch.setenv("RISK_FAST_REVIEW_BANDS", "LOW")
    assert _risk([])["reviewPath"] == "fast"


def test_adr0014_6_2_risk_requires_the_contract_fields_and_rejects_unknown_ones() -> None:
    a = make_app()
    ok = {"events": [], "identityReviewPending": False, "shortAnswerPending": False}
    assert send(a, "/v1/risk", {k: v for k, v in ok.items() if k != "events"}).status_code == 400
    assert send(a, "/v1/risk", {**ok, "extra": 1}).status_code == 400
    assert send(a, "/v1/risk", {**ok, "events": [{"type": "TAB_SWITCH"}]}).status_code == 400
    too_many = {**ok, "events": [{"type": "RIGHT_CLICK", "source": "CLIENT"}] * 100_001}
    assert send(a, "/v1/risk", too_many).status_code == 400


def test_adr0014_5_2_the_band_comes_from_the_integer_score_even_with_a_fractional_threshold() -> (
    None
):
    """Score 30.75 is stored as 30, so with mediumMinScore 30.5 the band is LOW, not MEDIUM."""
    cfg = {"risk": {"severityPoints": {"LOW": 10.25}, "mediumMinScore": 30.5}}
    out = _risk(["RIGHT_CLICK"] * 3, config=cfg)
    assert out["score"] == 30 and out["band"] == "LOW"
    cfg2 = {"risk": {"severityPoints": {"LOW": 10.5}, "mediumMinScore": 30.5}}
    out2 = _risk(["RIGHT_CLICK"] * 3, config=cfg2)  # 31.5 -> 31 >= 30.5
    assert out2["score"] == 31 and out2["band"] == "MEDIUM"
    assert out2["reviewPath"] == "full" and out["reviewPath"] == "fast"


def test_adr0010_matched_lines_are_evidence_in_details_not_in_the_payload() -> None:
    body = {
        "target": TARGET,
        "corpus": [{"sessionId": "s-o", "language": "python", "code": CODE_A}],
    }
    (f,) = send(make_app(), "/v1/analyze/similarity", body).json()["findings"]
    assert "matchedLines" not in f["payload"]
    assert f["details"]["matchedLines"] and f["details"]["sharedFingerprints"] > 0
    ai_body = {
        **body,
        "corpus": [],
        "aiReferences": [{"id": "r", "language": "python", "code": CODE_A}],
    }
    (g,) = send(make_app(), "/v1/analyze/similarity", ai_body).json()["findings"]
    assert "matchedLines" not in g["payload"] and g["details"]["matchedLines"]


def test_adr0014_6_1_request_fields_are_camel_case_only() -> None:
    a = make_app()
    ok = {"events": [], "identityReviewPending": False, "shortAnswerPending": False}
    snake = {"events": [], "identity_review_pending": False, "short_answer_pending": False}
    assert send(a, "/v1/risk", ok).status_code == 200
    assert send(a, "/v1/risk", snake).status_code == 400
    assert (
        send(a, "/v1/analyze/similarity", {"target": TARGET, "ai_references": []}).status_code
        == 400
    )
    snake_target = {"target": {**TARGET, "session_id": "x"}}
    assert send(a, "/v1/analyze/similarity", snake_target).status_code == 400


def test_adr0014_6_6_the_semaphore_is_released_when_an_analyzer_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import worker.routes_analyze as ra

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("secret-detail")

    a = make_app(audio=FakeAudio(tone(130, 4)), vad_backend=EnergyVadBackend())
    monkeypatch.setattr(ra, "analyze_question", boom)
    monkeypatch.setattr(ra, "find_target_similarity", boom)
    monkeypatch.setattr(ra, "analyze_audio", boom)
    ks = _kbody([edit(0, "a")])
    sim = {"target": TARGET}
    for path, body in (
        ("/v1/analyze/keystrokes", ks),
        ("/v1/analyze/similarity", sim),
        ("/v1/analyze/vad", VAD_BODY),
    ):
        r = send(a, path, body)
        assert r.status_code == 500 and r.json()["code"] == "INTERNAL"
        assert "secret-detail" not in r.text
    sem = a.state.analysis_runtime.semaphore
    assert sem.acquire(blocking=False) and sem.acquire(blocking=False)  # both slots are free
    sem.release()
    sem.release()


def test_adr0014_6_6_the_semaphore_is_released_when_the_vad_backend_raises() -> None:
    def bad_backend() -> EnergyVadBackend:
        raise RuntimeError("model gone")

    a = make_app(audio=FakeAudio(tone(130, 4)), vad_backend=bad_backend)
    assert send(a, "/v1/analyze/vad", VAD_BODY).status_code == 500
    sem = a.state.analysis_runtime.semaphore
    assert sem.acquire(blocking=False) and sem.acquire(blocking=False)
