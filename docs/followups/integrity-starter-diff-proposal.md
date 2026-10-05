# Proposal: diff submissions against the starter code before fingerprinting (FR-803)

Status: proposal for the architecture hub. Not implemented. Scope: apps/worker only.

## Problem

Today the worker ignores every k-gram of the starter code (`all_kgram_hashes`), then requires
`minFingerprints` (12) distinct fingerprints from each side. With identifiers normalized to `ID`,
generic patterns that appear in a large scaffold are ignored too, and when the candidate wrote
little, the gate skips comparison. Measured by `tests/test_similarity_large_starter.py` (scaffold
about 780 tokens, 3 TODO sites, 60 seeded pairs per row):

| Candidate-written code | Peer recall | Peer FP | AI recall | AI FP |
| --- | --- | --- | --- | --- |
| 3 sites x 2 statements | 100% | 0% | 100% | 0% |
| 3 sites x 1 statement | 98% | 0% | 98% | 0% |
| 1 site x 2 statements | 97% | 2% | 97% | 2% |
| 1 site x 1 statement | 48% | 3% | 48% | 0% |

One short fill-in in a large template loses more than half of genuine copies. Tagged MUST-FIX
BEFORE PILOT in docs/followups/integrity.md.

## Approach (preferred direction)

1. Per language, diff the submission against the starter on normalized lines (fall back to tokens
   inside changed lines): `difflib`-style longest matching blocks, bounded (see Cost).
2. Take the changed spans (inserted or replaced code) plus a context margin of `k + window - 2`
   tokens on each side so k-grams that straddle a region edge are not lost; merge spans whose
   margins overlap.
3. Normalize and winnow only those spans (the margin tokens stay in the k-grams but a fingerprint
   that lies entirely inside starter text is dropped).
4. Apply the size gate to changed-region fingerprints. `minFingerprints` then means "distinct
   fingerprints the candidate contributed", so it can drop (about 4-6) without admitting scaffold
   text. Add a floor `minChangedTokens` (about 12).
5. Compare as today (containment), same thresholds, same idiom filter; matched lines still refer to
   the candidate's own code.
6. The AI path does the same: the reference solution is diffed against the starter too, so both
   sides contribute only their own code.

## Edge cases to handle and test

- Candidate deletes or reorders starter lines: deletions contribute nothing; reordered starter
  blocks count as moved, not changed (match blocks regardless of position).
- Edits inside a starter line (a TODO line completed in place): token-level diff inside the line.
- A starter line moved elsewhere: matched by content, not position.
- Whitespace-only or formatter changes: normalization removes them, so no changed span.
- Code added far from TODO sites (helpers, new functions): changed span like any other.
- No starter for the language: whole submission is the changed region (today's behaviour).
- Region boundaries: the context margin above; test with an edit one token from a boundary.
- Starter edited by the author after candidates started: use the version the session saw.

## False-positive risks

Very short changed regions look alike across independent solutions (`return result`, a loop
header), and idioms recur. Keep the idiom filter and the `minChangedTokens` floor. Consider
returning a low-confidence finding (confidence scaled by changed size) instead of none for regions
just under the floor, so the reviewer sees the evidence; this is a product decision. Starter diffs
cannot make a copy of the scaffold alone match, because unchanged text is excluded.

## Alternatives considered

- Lower `k` or `minFingerprints` for large-starter questions: raises recall but also lets scaffold
  text and idioms in; the false positive rate is not bounded by anything structural.
- Require authors to keep starter templates small: cheap, but a product constraint that hurts
  question design (FR-201..204) and does not fix existing content.
- Diffing is preferred because it removes the scaffold by construction, so thresholds stay
  meaningful and recall depends on what the candidate wrote, not on template size.

## Config and contracts

New keys under `similarity.*` (defaults documented in INTEGRITY-CONFIG.md): `diffContextMargin`
(derived by default), `minChangedTokens`, a possibly lower `minFingerprints`, and a `diffEnabled`
switch for rollback. No change to packages/shared, the API or the DB expected: starter code is
already sent per request, and finding payloads are unchanged.

## Cost

A diff is O(n*m) worst case. Bound it: compare line hashes first (linear with a hash map for the
common case), cap lines per side (for example 5,000, matching MAX_SOURCE_CODE_LENGTH 100,000 chars),
and fall back to today's ignore-all-starter-k-grams path if the cap is exceeded. Diff the starter
once per language per request (the request-level preparation is already in place); each submission
costs one bounded diff.

## How to measure

Reuse `tests/test_similarity_large_starter.py` (same 60 seeds, same four rows) and add rows for the
edge cases above (edit inside a starter line, moved starter block, whitespace-only change, helper
added far from TODO sites, edit at a region boundary, deleted starter lines). Report recall and FP
before and after. Acceptance criteria:

- weak row (1 site x 1 statement) recall >= 0.90 with peer and AI FP <= 0.05;
- no regression on the other three rows, nor on the existing TC-074 / FR-803 tests;
- 150-submission request within the current budget (peer 1.2 s, AI 0.3 s on a laptop).

Plan: raise the floors in the test to the new measured values minus one pair (do not lower any),
and mark the weak-row assertion as `xfail(strict=True)` against the target before the change, so
the change flips it to pass instead of loosening floors.

## Decisions needed from the hub

1. Approve diffing against the starter as the direction (versus lower thresholds or small templates).
2. Low-confidence findings for regions under the floor, or no finding?
3. Acceptable `minFingerprints` / `minChangedTokens` defaults, and the rollback switch.
4. Which starter version applies when authors edit a question version (immutable once published, FR-204?).
5. Whether a pilot gate on this item is a hard blocker for enabling CODE_SIMILARITY / AI_LIKENESS.
