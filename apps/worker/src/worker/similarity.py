"""Code similarity: normalization plus winnowing fingerprints, MOSS style (FR-803, TC-074).

Pipeline: tokenize (comments and whitespace dropped, strings and numbers collapsed, identifiers
renamed to one placeholder, keywords kept) -> k-gram hashes -> winnowing (Schleimer, Wilkerson,
Aiken 2003) -> compare fingerprint sets. Similarity is containment: shared fingerprints divided by
the smaller set, so a candidate who copied a function into a longer solution still scores high.

Evidence, not verdict: every result carries the similarity, the matched line ranges and a
confidence. Short code and common idioms lower confidence or are skipped, because honest candidates
solving a small problem write near-identical code (known false positive).
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from worker.config import IntegrityConfig, SimilarityConfig
from worker.events import CodeLanguage, Finding

_KEYWORDS: Final[dict[CodeLanguage, frozenset[str]]] = {
    "python": frozenset(
        "False None True and as assert async await break class continue def del elif else except "
        "finally for from global if import in is lambda nonlocal not or pass raise return try "
        "while with yield self".split()
    ),
    "javascript": frozenset(
        "async await break case catch class const continue debugger default delete do else export "
        "extends false finally for function if import in instanceof let new null of return super "
        "switch this throw true try typeof undefined var void while with yield".split()
    ),
    "java": frozenset(
        "abstract boolean break byte case catch char class const continue default do double else "
        "enum extends final finally float for if implements import instanceof int interface long "
        "new null package private protected public return short static super switch this throw "
        "throws true false try void volatile while String".split()
    ),
}

_COMMENTS: Final[dict[CodeLanguage, str]] = {
    "python": r"\#[^\n]*",
    "javascript": r"/\*.*?\*/|//[^\n]*",
    "java": r"/\*.*?\*/|//[^\n]*",
}

_PATTERN_TEMPLATE: Final = r"""
    (?P<ws>\s+)
  | (?P<comment>{comment})
  | (?P<tstring>\"\"\".*?\"\"\"|'''.*?''')
  | (?P<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)
  | (?P<number>0[xX][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?[lLfF]?|\.\d+)
  | (?P<ident>[A-Za-z_$][A-Za-z0-9_$]*)
  | (?P<op>>>>=?|<<=|>>=|\*\*=?|//=|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|->|=>|::|//
          |[-+*/%&|^~<>=!?:.,;(){{}}\[\]@])
"""

_TOKEN_RES: Final[dict[CodeLanguage, re.Pattern[str]]] = {
    lang: re.compile(_PATTERN_TEMPLATE.format(comment=c), re.VERBOSE | re.DOTALL)
    for lang, c in _COMMENTS.items()
}


@dataclass(frozen=True, slots=True)
class Token:
    text: str
    line: int  # 1-based line in the original source


def normalize(source: str, language: CodeLanguage) -> list[Token]:
    """Tokens with comments removed, literals collapsed and identifiers renamed to `ID`.

    Unknown characters are skipped, so malformed or partial code (common mid-test) never raises.
    """
    keywords = _KEYWORDS[language]
    tokens: list[Token] = []
    line = 1
    for m in _TOKEN_RES[language].finditer(source):
        kind = m.lastgroup
        text = m.group()
        start_line = line
        line += text.count("\n")
        if kind in ("ws", "comment"):
            continue
        if kind in ("string", "tstring"):
            tokens.append(Token("STR", start_line))
        elif kind == "number":
            tokens.append(Token("NUM", start_line))
        elif kind == "ident":
            tokens.append(Token(text if text in keywords else "ID", start_line))
        else:
            tokens.append(Token(text, start_line))
    return tokens


def _hash(gram: Sequence[str]) -> int:
    digest = hashlib.blake2b("\x1f".join(gram).encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big")


@dataclass(frozen=True, slots=True)
class Fingerprint:
    hash: int
    position: int  # index of the k-gram's first token


def winnow(tokens: Sequence[Token], k: int, window: int) -> list[Fingerprint]:
    """Winnowing: in each window of `window` k-gram hashes keep the minimum (rightmost on ties)."""
    texts = [t.text for t in tokens]
    if len(texts) < k:
        return []
    hashes = [_hash(texts[i : i + k]) for i in range(len(texts) - k + 1)]
    if len(hashes) <= window:
        i = min(range(len(hashes)), key=lambda x: (hashes[x], -x))
        return [Fingerprint(hashes[i], i)]
    selected: dict[int, Fingerprint] = {}
    for start in range(len(hashes) - window + 1):
        best = start
        for j in range(start, start + window):
            if hashes[j] <= hashes[best]:
                best = j
        selected[best] = Fingerprint(hashes[best], best)
    return [selected[i] for i in sorted(selected)]


@dataclass(frozen=True, slots=True)
class PreparedCode:
    tokens: list[Token]
    fingerprints: list[Fingerprint]

    @property
    def hashes(self) -> frozenset[int]:
        return frozenset(f.hash for f in self.fingerprints)


def prepare(source: str, language: CodeLanguage, cfg: SimilarityConfig) -> PreparedCode:
    tokens = normalize(source, language)
    return PreparedCode(tokens, winnow(tokens, cfg.k, cfg.window))


@dataclass(frozen=True, slots=True)
class Comparison:
    similarity: float
    shared: int
    confidence: float
    matched_lines: list[tuple[int, int]]  # inclusive line ranges in the first (candidate) code


def _line_ranges(
    prep: PreparedCode, shared: frozenset[int], k: int, limit: int
) -> list[tuple[int, int]]:
    lines: set[int] = set()
    for f in prep.fingerprints:
        if f.hash in shared:
            lo = prep.tokens[f.position].line
            hi = prep.tokens[min(f.position + k - 1, len(prep.tokens) - 1)].line
            lines.update(range(lo, hi + 1))
    ranges: list[tuple[int, int]] = []
    for ln in sorted(lines):
        if ranges and ln <= ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], ln)
        else:
            ranges.append((ln, ln))
    return ranges[:limit]


def compare(
    a: PreparedCode,
    b: PreparedCode,
    cfg: SimilarityConfig,
    ignore: frozenset[int] = frozenset(),
) -> Comparison | None:
    """Containment similarity of `a` and `b` ignoring `ignore` hashes. None if too short."""
    if len(a.tokens) < cfg.min_tokens or len(b.tokens) < cfg.min_tokens:
        return None
    ha = a.hashes - ignore
    hb = b.hashes - ignore
    if not ha or not hb:
        return None
    shared = ha & hb
    similarity = len(shared) / min(len(ha), len(hb))
    # Short code is weak evidence: confidence grows with size up to 4x the minimum.
    size = min(len(a.tokens), len(b.tokens))
    size_factor = min(1.0, 0.5 + 0.5 * (size - cfg.min_tokens) / (3 * cfg.min_tokens))
    return Comparison(
        similarity=round(similarity, 4),
        shared=len(shared),
        confidence=round(min(1.0, similarity) * size_factor, 3),
        matched_lines=_line_ranges(a, frozenset(shared), cfg.k, cfg.max_matched_ranges),
    )


@dataclass(frozen=True, slots=True)
class Submission:
    session_id: str
    session_question_id: str
    language: CodeLanguage
    code: str
    occurred_at_ms: int = 0


@dataclass(frozen=True, slots=True)
class AiReference:
    """Row of ai_reference_solutions (ADR 0005 section 4). Only the worker reads these (AI-3)."""

    id: str
    language: CodeLanguage
    code: str
    is_variant_match: bool = False  # variant rows are compared first (AI-2)


def _flat(ranges: list[tuple[int, int]]) -> list[int]:
    return [n for r in ranges for n in r]


def _ignore_set(
    corpus: Sequence[PreparedCode], boilerplate: PreparedCode | None, cfg: SimilarityConfig
) -> frozenset[int]:
    ignore: set[int] = set(boilerplate.hashes) if boilerplate else set()
    if len(corpus) >= cfg.common_min_corpus:
        counts: dict[int, int] = {}
        for s in corpus:
            for h in s.hashes:
                counts[h] = counts.get(h, 0) + 1
        limit = cfg.common_fingerprint_share * len(corpus)
        ignore |= {h for h, c in counts.items() if c > limit}
    return frozenset(ignore)


def find_peer_similarity(
    submissions: Sequence[Submission],
    config: IntegrityConfig | None = None,
    starter_code: Mapping[CodeLanguage, str] | None = None,
) -> dict[str, list[Finding]]:
    """CODE_SIMILARITY findings per session id for submissions to the same question version.

    Both sides of a pair get a finding (TC-074). Starter code and fingerprints shared by more than
    half of a large corpus are ignored. Returns {} when the detector is disabled (FR-305).
    """
    cfg = config or IntegrityConfig()
    if not cfg.is_enabled("CODE_SIMILARITY"):
        return {}
    sc = cfg.similarity
    out: dict[str, list[Finding]] = {}
    by_lang: dict[CodeLanguage, list[Submission]] = {}
    for s in submissions:
        by_lang.setdefault(s.language, []).append(s)
    for lang, subs in by_lang.items():
        prepared = [prepare(s.code, lang, sc) for s in subs]
        boiler = (
            prepare(starter_code[lang], lang, sc) if starter_code and lang in starter_code else None
        )
        ignore = _ignore_set(prepared, boiler, sc)
        for i, (si, pi) in enumerate(zip(subs, prepared, strict=True)):
            matches: list[tuple[Comparison, Submission]] = []
            for j, (sj, pj) in enumerate(zip(subs, prepared, strict=True)):
                if i == j or si.session_id == sj.session_id:
                    continue
                c = compare(pi, pj, sc, ignore)
                if c is not None and c.similarity >= sc.peer_threshold:
                    matches.append((c, sj))
            matches.sort(key=lambda m: (-m[0].similarity, m[1].session_id))
            for c, other in matches[: sc.max_peer_matches]:
                out.setdefault(si.session_id, []).append(
                    Finding(
                        type="CODE_SIMILARITY",
                        occurred_at_ms=si.occurred_at_ms,
                        duration_ms=0,
                        confidence=c.confidence,
                        payload={
                            "sessionQuestionId": si.session_question_id,
                            "similarity": c.similarity,
                            "matchedSessionId": other.session_id,
                            "matchedLines": _flat(c.matched_lines),
                        },
                        details={"sharedFingerprints": c.shared},
                    )
                )
    return out


def find_ai_likeness(
    submission: Submission,
    references: Sequence[AiReference],
    config: IntegrityConfig | None = None,
) -> list[Finding]:
    """AI_LIKENESS: the best match against stored AI reference solutions (AI-1, AI-2).

    Compares only references in the submission's language, variant rows first, and cites the
    best-matching row. Never used for grading (AI-3). One finding at most, so a question with many
    reference rows cannot flood the timeline.
    """
    cfg = config or IntegrityConfig()
    if not cfg.is_enabled("AI_LIKENESS"):
        return []
    sc = cfg.similarity
    prep = prepare(submission.code, submission.language, sc)
    ordered = sorted(
        (r for r in references if r.language == submission.language),
        key=lambda r: not r.is_variant_match,
    )
    best: tuple[Comparison, AiReference] | None = None
    for ref in ordered:
        c = compare(prep, prepare(ref.code, ref.language, sc), sc)
        if c is not None and (best is None or c.similarity > best[0].similarity):
            best = (c, ref)
    if best is None or best[0].similarity < sc.ai_threshold:
        return []
    c, ref = best
    return [
        Finding(
            type="AI_LIKENESS",
            occurred_at_ms=submission.occurred_at_ms,
            duration_ms=0,
            confidence=c.confidence,
            payload={
                "sessionQuestionId": submission.session_question_id,
                "similarity": c.similarity,
                "aiReferenceSolutionId": ref.id,
                "matchedLines": _flat(c.matched_lines),
            },
            details={"sharedFingerprints": c.shared},
        )
    ]
