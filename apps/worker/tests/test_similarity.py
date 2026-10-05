from __future__ import annotations

import random
import time

from helpers import num
from worker.config import IntegrityConfig, SimilarityConfig
from worker.events import CodeLanguage
from worker.similarity import (
    AiReference,
    Submission,
    Token,
    all_kgram_hashes,
    compare,
    find_ai_likeness,
    find_peer_similarity,
    normalize,
    prepare,
    prepare_ai_context,
    winnow,
)

SC = SimilarityConfig()

PY_A = '''
def top_k_frequent(words, k):
    """Return the k most frequent words."""
    counts = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1   # count each word
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    result = []
    for word, _ in ordered[:k]:
        result.append(word)
    return result
'''

# Same logic: identifiers renamed, comments and layout changed (the classic disguise).
PY_A_DISGUISED = """
def solve(tokens, limit):
    # tally
    freq = {}
    for t in tokens:
        freq[t] = freq.get(t, 0) + 1
    ranked = sorted(freq.items(),
                    key=lambda pair: (-pair[1], pair[0]))
    out = []
    for name, _ in ranked[:limit]:
        out.append(name)
    return out
"""

# A genuinely different solution to the same problem.
PY_A_OTHER = """
import heapq
from collections import Counter

def top_k_frequent(words, k):
    c = Counter(words)
    heap = [(-n, w) for w, n in c.items()]
    heapq.heapify(heap)
    return [heapq.heappop(heap)[1] for _ in range(min(k, len(heap)))]
"""

JS_A = """
function topK(words, k) {
  const counts = new Map();
  for (const w of words) { counts.set(w, (counts.get(w) || 0) + 1); }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ordered.slice(0, k).map(([w]) => w);
}
"""

JAVA_A = """
import java.util.*;
public class Solution {
    public List<String> topK(List<String> words, int k) {
        Map<String, Integer> counts = new HashMap<>();
        for (String w : words) { counts.merge(w, 1, Integer::sum); }
        List<String> keys = new ArrayList<>(counts.keySet());
        keys.sort((a, b) -> counts.get(b) - counts.get(a));
        return keys.subList(0, k);
    }
}
"""


def sub(sid: str, code: str, lang: CodeLanguage = "python") -> Submission:
    return Submission(session_id=sid, session_question_id=f"q-{sid}", language=lang, code=code)


# ---------- Normalization ----------


def test_fr803_normalize_strips_comments_whitespace_and_renames_identifiers() -> None:
    toks = [t.text for t in normalize("x = foo(1, 'a')  # note\n", "python")]
    assert toks == ["ID", "=", "ID", "(", "NUM", ",", "STR", ")"]


def test_fr803_normalize_keeps_keywords_and_python_floor_division() -> None:
    toks = [t.text for t in normalize("if a // b: return None", "python")]
    assert toks == ["if", "ID", "//", "ID", ":", "return", "None"]


def test_fr803_normalize_handles_js_and_java_comments_and_templates() -> None:
    js = [t.text for t in normalize("/* c */ const a = `x${1}`; // t\n", "javascript")]
    assert js == ["const", "ID", "=", "STR", ";"]
    java = [t.text for t in normalize('int a = 1; /* multi\nline */ String s = "q";', "java")]
    assert java == ["int", "ID", "=", "NUM", ";", "String", "ID", "=", "STR", ";"]


def test_fr803_normalize_tracks_original_line_numbers() -> None:
    toks = normalize("a = 1\n\n# c\nb = 2\n", "python")
    assert [t.line for t in toks] == [1, 1, 1, 4, 4, 4]


def test_fr803_normalize_never_raises_on_partial_or_garbage_code() -> None:
    assert normalize("def (((  \x00 ???", "python")  # no exception, returns what it can
    assert normalize("", "java") == []


# ---------- Winnowing guarantee ----------


def test_fr803_winnowing_guarantee_shared_run_of_w_plus_k_minus_1_tokens_is_detected() -> None:
    rng = random.Random(5)
    k, w = 5, 4
    vocab = [f"t{i}" for i in range(500)]
    shared = [Token(rng.choice(vocab), 1) for _ in range(w + k - 1)]
    for _ in range(25):
        a = [Token(rng.choice(vocab), 1) for _ in range(60)] + shared
        b = shared + [Token(rng.choice(vocab), 1) for _ in range(60)]
        ha = {f.hash for f in winnow(a, k, w)}
        hb = {f.hash for f in winnow(b, k, w)}
        assert ha & hb


def test_fr803_winnow_short_input_yields_nothing_or_one() -> None:
    assert winnow([Token("a", 1)] * 3, 5, 4) == []
    assert len(winnow([Token("a", 1), Token("b", 1)] * 3, 5, 4)) == 1


# ---------- Peer similarity (TC-074) ----------


def test_tc074_identical_submissions_flag_both_sessions() -> None:
    res = find_peer_similarity([sub("s1", PY_A), sub("s2", PY_A)])
    assert set(res) == {"s1", "s2"}
    f = res["s1"][0]
    assert f.type == "CODE_SIMILARITY"
    assert f.payload["matchedSessionId"] == "s2"
    assert f.payload["similarity"] == 1.0
    assert "aiReferenceSolutionId" not in f.payload
    assert f.payload["matchedLines"]  # evidence: which lines


def test_fr803_renamed_variables_and_changed_comments_still_match() -> None:
    res = find_peer_similarity([sub("s1", PY_A), sub("s2", PY_A_DISGUISED)])
    assert num(res["s1"][0].payload["similarity"]) >= 0.8


def test_fr803_false_positive_different_valid_solution_is_not_flagged() -> None:
    assert find_peer_similarity([sub("s1", PY_A), sub("s2", PY_A_OTHER)]) == {}


def test_fr803_reordered_functions_still_match() -> None:
    helper = "def helper(x):\n    return [i * 2 for i in x if i % 3 == 0 and i > 10]\n\n"
    a = helper + PY_A
    b = PY_A + "\n" + helper
    res = find_peer_similarity([sub("s1", a), sub("s2", b)])
    assert num(res["s1"][0].payload["similarity"]) >= 0.8


def test_fr803_false_positive_trivially_short_solutions_are_skipped() -> None:
    tiny = "def add(a, b):\n    return a + b\n"
    assert find_peer_similarity([sub("s1", tiny), sub("s2", tiny)]) == {}


def test_fr803_starter_code_is_not_counted_as_copying() -> None:
    starter = PY_A  # the candidate was handed this scaffold
    res = find_peer_similarity(
        [sub("s1", starter), sub("s2", starter)], starter_code={"python": starter}
    )
    assert res == {}


def test_fr803_false_positive_common_idiom_in_large_corpus_is_ignored() -> None:
    boiler = (
        "import sys\n"
        "def main():\n    data = sys.stdin.read().split()\n    n = int(data[0])\n"
        "    values = [int(x) for x in data[1:n + 1]]\n    print(sum(values))\n"
        "if __name__ == '__main__':\n    main()\n"
    )
    unique = [
        f"def f{i}(a):\n    return [x * {i + 2} for x in a if x % {i + 3} == 0 and x > {i}]\n"
        + "\n".join(f"v{i}_{j} = {j} ** {i + j + 2} + len(a) * {j}" for j in range(12))
        for i in range(8)
    ]
    subs = [sub(f"s{i}", boiler + u) for i, u in enumerate(unique)]
    assert find_peer_similarity(subs) == {}


def test_fr803_only_same_language_is_compared() -> None:
    assert find_peer_similarity([sub("s1", PY_A), sub("s2", JS_A, "javascript")]) == {}


def test_fr803_javascript_and_java_copies_are_detected() -> None:
    for code, lang in ((JS_A, "javascript"), (JAVA_A, "java")):
        res = find_peer_similarity([sub("a", code, lang), sub("b", code, lang)])  # type: ignore[arg-type]
        assert set(res) == {"a", "b"}


def test_fr803_threshold_is_configurable() -> None:
    strict = IntegrityConfig.model_validate({"similarity": {"peerThreshold": 1.0}})
    partial = PY_A_DISGUISED.replace("out.append(name)", "out.append(name.lower())")
    res = find_peer_similarity([sub("s1", PY_A), sub("s2", partial)], strict)
    assert res == {}


def test_fr803_same_session_is_never_compared_with_itself() -> None:
    a = Submission("s1", "q1", "python", PY_A)
    b = Submission("s1", "q2", "python", PY_A)
    assert find_peer_similarity([a, b]) == {}


def test_fr803_matches_per_session_are_capped_and_best_first() -> None:
    subs = [sub(f"s{i}", PY_A) for i in range(6)]
    res = find_peer_similarity(subs)
    assert all(len(v) == 3 for v in res.values())


def test_fr305_disabled_similarity_does_not_run() -> None:
    cfg = IntegrityConfig(disabled_event_types=frozenset({"CODE_SIMILARITY"}))
    assert find_peer_similarity([sub("s1", PY_A), sub("s2", PY_A)], cfg) == {}


def test_fr803_compare_none_when_too_short_and_confidence_grows_with_size() -> None:
    short = prepare("a = 1", "python", SC)
    long = prepare(PY_A, "python", SC)
    assert compare(short, long, SC) is None
    c = compare(long, long, SC)
    assert c is not None and 0.5 < c.confidence <= 1.0


# ---------- AI likeness (FR-803, ADR 0005 AI-1, AI-2) ----------


def test_fr803_ai_likeness_cites_the_matching_reference_row() -> None:
    refs = [
        AiReference("ref-other", "python", PY_A_OTHER),
        AiReference("ref-match", "python", PY_A_DISGUISED),
    ]
    out = find_ai_likeness(sub("s1", PY_A), refs)
    assert len(out) == 1
    assert out[0].type == "AI_LIKENESS"
    assert out[0].payload["aiReferenceSolutionId"] == "ref-match"
    assert "matchedSessionId" not in out[0].payload


def test_fr803_ai_likeness_ignores_other_languages_and_low_similarity() -> None:
    refs = [AiReference("j", "java", JAVA_A), AiReference("o", "python", PY_A_OTHER)]
    assert find_ai_likeness(sub("s1", PY_A), refs) == []


def test_fr803_ai_likeness_variant_rows_win_ties() -> None:
    refs = [
        AiReference("base", "python", PY_A),
        AiReference("variant", "python", PY_A, is_variant_match=True),
    ]
    assert find_ai_likeness(sub("s1", PY_A), refs)[0].payload["aiReferenceSolutionId"] == "variant"


def test_fr305_disabled_ai_likeness_does_not_run() -> None:
    cfg = IntegrityConfig(disabled_event_types=frozenset({"AI_LIKENESS"}))
    assert find_ai_likeness(sub("s1", PY_A), [AiReference("r", "python", PY_A)], cfg) == []


JAVA_SCAFFOLD = """
import java.util.*;
public class Solution {
    public List<String> topK(List<String> words, int k) {
        Map<String, Integer> counts = new HashMap<>();
        List<String> result = new ArrayList<>();
        int n = words.size();
        // TODO
        return result;
    }
}
"""
STARTER: dict[CodeLanguage, str] = {"java": JAVA_SCAFFOLD}


def test_fr803_scaffold_fixture_is_long_enough_to_be_compared() -> None:
    assert len(normalize(JAVA_SCAFFOLD, "java")) >= SC.min_tokens


def test_fr803_blank_scaffold_is_not_ai_likeness() -> None:
    refs = [AiReference("r", "java", JAVA_SCAFFOLD)]  # AI answer that is mostly the scaffold
    s = sub("s1", JAVA_SCAFFOLD, "java")
    assert find_ai_likeness(s, refs, starter_code=STARTER) == []
    control = find_ai_likeness(s, refs)  # without the starter code it is a false alarm
    assert len(control) == 1 and control[0].type == "AI_LIKENESS"


def test_fr803_starter_plus_same_one_liner_is_not_peer_similarity() -> None:
    code = JAVA_SCAFFOLD.replace("// TODO", "int m = k;")
    subs = [sub("a", code, "java"), sub("b", code, "java")]
    assert find_peer_similarity(subs, starter_code=STARTER) == {}
    assert set(find_peer_similarity(subs)) == {"a", "b"}  # control


def test_fr803_real_copy_on_top_of_starter_is_still_flagged() -> None:
    res = find_peer_similarity(
        [sub("a", JAVA_A, "java"), sub("b", JAVA_A, "java")], starter_code=STARTER
    )
    assert set(res) == {"a", "b"}


def test_nfr04_unterminated_block_comments_are_linear_time() -> None:
    hostile = "/*a" * 30000  # never forms "*/": quadratic under the old pattern
    start = time.perf_counter()
    normalize(hostile, "java")
    normalize(hostile, "javascript")
    assert time.perf_counter() - start < 2.0


_OPS = ["+", "-", "*", "%", "//", "**", "&", "|", "^", "<<", ">>", "+ 1 +", "- 2 -", "* 3 *"]
_HELPERS = "\n".join(
    f"def helper_{i}(v):\n    out = []\n    for j in range(len(v)):\n"
    f"        if v[j] {op} len(v) > j {_OPS[(i + 3) % 14]} 1:\n            out.append(v[j] {op} j)\n"
    f"    return out\n"
    for i, op in enumerate(_OPS)
)
MULTI_TODO = (
    _HELPERS
    + """
def process(items, limit):
    cleaned = []
    # TODO 1: filter the items
    ranked = sorted(cleaned, key=lambda item: (item[1], item[0]))
    # TODO 2: group the ranked items
    groups = {}
    for entry in ranked:
        groups.setdefault(entry[0], []).append(entry[1])
    # TODO 3: build the answer
    answer = []
    return answer[:limit]
"""
)
TODO_SITES = (
    "# TODO 1: filter the items",
    "# TODO 2: group the ranked items",
    "# TODO 3: build the answer",
)


def _fill(site: int, tag: str) -> str:
    body = "\n    ".join(
        f"{tag}{i} = items[{i}] {op} len(items) {_OPS[(i + 5) % 14]} {i}"
        for i, op in enumerate(_OPS)
    )
    return MULTI_TODO.replace(TODO_SITES[site], body)


def test_fr803_starter_kgrams_skipped_by_winnowing_do_not_leak_back_as_evidence() -> None:
    """Edits at different TODO sites make skipped starter k-grams selectable; ignore them all."""
    assert len(normalize(MULTI_TODO, "python")) >= SC.min_tokens
    a, b = _fill(0, "p"), _fill(2, "q")
    pa, pb = prepare(a, "python", SC), prepare(b, "python", SC)
    winnowed = prepare(MULTI_TODO, "python", SC).hashes
    every = all_kgram_hashes(MULTI_TODO, "python", SC.k)
    old = compare(pa, pb, SC, winnowed)
    new = compare(pa, pb, SC, every)
    assert old is not None and new is not None
    assert old.shared > new.shared  # precondition: starter k-grams leak under the old ignore set
    starter: dict[CodeLanguage, str] = {"python": MULTI_TODO}
    peer = find_peer_similarity([sub("a", a), sub("b", b)], starter_code=starter)
    assert peer["a"][0].details["sharedFingerprints"] == new.shared
    ai = find_ai_likeness(sub("a", a), [AiReference("r", "python", b)], starter_code=starter)
    assert ai[0].details["sharedFingerprints"] == new.shared


def _ai_equivalence_cases() -> list[tuple[Submission, list[AiReference], dict[CodeLanguage, str]]]:
    refs = [
        AiReference("py-base", "python", PY_A),
        AiReference("py-variant", "python", PY_A, is_variant_match=True),  # tied with the base row
        AiReference("py-other", "python", PY_A_OTHER),
        AiReference("js", "javascript", JS_A),
        AiReference("java", "java", JAVA_A),
    ]
    return [
        (sub("a", PY_A), refs, {}),
        (sub("b", JS_A, "javascript"), refs, {}),
        (sub("c", JAVA_A, "java"), refs, {}),
        (sub("d", PY_A_DISGUISED), refs, {"python": PY_A_OTHER}),
        (sub("e", PY_A), refs, {"java": JAVA_SCAFFOLD}),  # starter for a different language only
        (sub("f", PY_A_OTHER), refs, {"python": PY_A}),
    ]


def test_fr803_prepared_context_gives_identical_ai_results() -> None:
    for s, refs, starter in _ai_equivalence_cases():
        cfg = IntegrityConfig()
        ctx = prepare_ai_context(refs, cfg, starter)
        assert find_ai_likeness(s, refs, cfg, starter, context=ctx) == find_ai_likeness(
            s, refs, cfg, starter
        )


def test_fr803_prepared_context_variant_row_wins_tie_like_the_direct_call() -> None:
    s, refs, starter = _ai_equivalence_cases()[0]
    ctx = prepare_ai_context(refs, None, starter)
    out = find_ai_likeness(s, refs, None, starter, context=ctx)
    assert out and out[0].payload["aiReferenceSolutionId"] == "py-variant"


def test_fr305_prepared_context_respects_disabled_ai_likeness() -> None:
    cfg = IntegrityConfig(disabled_event_types=frozenset({"AI_LIKENESS"}))
    for s, refs, starter in _ai_equivalence_cases():
        ctx = prepare_ai_context(refs, cfg, starter)
        assert find_ai_likeness(s, refs, cfg, starter, context=ctx) == []
        assert find_ai_likeness(s, refs, cfg, starter) == []
