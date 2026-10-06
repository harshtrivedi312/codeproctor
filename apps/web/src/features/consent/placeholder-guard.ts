import type { ConsentDocument } from '@/features/candidate-flow/wire';

/**
 * The placeholder guard (FR-401, C-09). A consent text may be shown for acceptance only when the
 * API says Legal approved it AND the text itself carries no sign of a draft. Anything doubtful
 * fails closed: the candidate sees an "unavailable" screen and no accept control exists.
 *
 * The approved text must therefore be free of square-bracket fill-ins such as "[x.y]", "[address]"
 * or "[N]", of the words PLACEHOLDER, DRAFT, TODO or TBD, and of example.com addresses. A markdown
 * link "[text](url)" is fine. Empty checkbox forms "[ ]" are not treated as fill-ins.
 */
export type GuardResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_APPROVED' | 'APPROVAL_REQUIRED' | 'PLACEHOLDER_TEXT' | 'EMPTY' };

const BRACKET_FILL_IN = /\[(?=[^\]\n]*[^\s\]])[^\]\n]*\](?!\()/;
const DRAFT_WORDS = /\b(placeholder|draft|lorem ipsum|todo|tbd)\b/i;
const EXAMPLE_ADDRESS = /@example\.(com|org|net)\b/i;
const NOT_APPROVED_PHRASES =
  /\b(not (yet )?(been )?(approved|reviewed)|pending (legal )?approval|for owner approval)\b/i;

export function evaluateConsentDocument(doc: ConsentDocument): GuardResult {
  if (!doc.legalApproved) return { ok: false, reason: 'NOT_APPROVED' };
  if (doc.legalApprovalRequired === true) return { ok: false, reason: 'APPROVAL_REQUIRED' };
  const text = doc.bodyMd;
  if (text.trim().length < 200 || doc.version.trim() === '') return { ok: false, reason: 'EMPTY' };
  if (
    BRACKET_FILL_IN.test(text) ||
    DRAFT_WORDS.test(text) ||
    EXAMPLE_ADDRESS.test(text) ||
    NOT_APPROVED_PHRASES.test(text) ||
    BRACKET_FILL_IN.test(doc.version) ||
    DRAFT_WORDS.test(doc.version)
  ) {
    return { ok: false, reason: 'PLACEHOLDER_TEXT' };
  }
  return { ok: true };
}
