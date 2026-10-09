import {
  MAX_KEYSTROKE_BATCH_BODY_BYTES,
  MAX_KEYSTROKE_BATCH_TEXT,
  MAX_KEYSTROKE_BATCH_TOTAL_TEXT,
  MAX_KEYSTROKE_EVENTS_PER_BATCH,
  MAX_KEYSTROKE_OFFSET_MS,
  keystrokeEventSchema,
  type CodeLanguage,
} from '@codeproctor/shared';
import { BatchQueue, type BatchQueueOptions, type BatchQueueSpec } from '../core/batch-queue';
import { canonicalJson } from '../core/canonical';

/**
 * One recorded editor change before it is cut into a batch. `atMs` is the client clock when it
 * happened; `t` (ms from the batch's `startedAt`) is computed when the batch is cut.
 *
 * Privacy (NFR-05, ADR 0010): only editor MODEL changes. No key codes, modifiers or text typed
 * outside the editor. The `text` fields are never logged, put in an error message or a flag.
 */
export type PendingEditorEvent = { sessionQuestionId: string; atMs: number } & (
  | { kind: 'RESET'; language: CodeLanguage; text: string }
  | { kind: 'EDIT'; offset: number; deleteLength: number; text: string }
  | { kind: 'CURSOR'; offset: number; selectionLength?: number }
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 9999-12-31T23:59:59.999Z, the last instant `toISOString` writes as a plain four-digit year. */
const MAX_ATMS = 253_402_300_799_999;
const bodyBytes = (s: string): number => new TextEncoder().encode(s).length;

/** Event with its batch-relative time, with explicit fields only (nothing else is ever signed). */
function withT(e: PendingEditorEvent, startedAtMs: number): Record<string, unknown> {
  const t = Math.max(0, Math.round(e.atMs - startedAtMs));
  if (e.kind === 'RESET') return { kind: 'RESET', t, language: e.language, text: e.text };
  if (e.kind === 'EDIT') {
    return { kind: 'EDIT', t, offset: e.offset, deleteLength: e.deleteLength, text: e.text };
  }
  return e.selectionLength === undefined
    ? { kind: 'CURSOR', t, offset: e.offset }
    : { kind: 'CURSOR', t, offset: e.offset, selectionLength: e.selectionLength };
}

/**
 * Build one keystroke batch from the front of `pending` (all for one question) within the limits
 * of the shared schema and the body limit: at most 1000 events, `t` within 10 minutes of the batch
 * start, EDIT text at most MAX_KEYSTROKE_BATCH_TEXT, RESET plus EDIT text at most
 * MAX_KEYSTROKE_BATCH_TOTAL_TEXT, and a body under MAX_KEYSTROKE_BATCH_BODY_BYTES measured on the
 * real canonical string (worst case \uXXXX escaping). Always consumes at least one event.
 */
export function cutKeystrokeBatch(
  pending: readonly PendingEditorEvent[],
  seq: number,
): { body: string; consumed: number } {
  const first = pending[0];
  if (!first) throw new Error('nothing to cut');
  const q = first.sessionQuestionId;
  const startedAtMs = first.atMs;
  let count = 0;
  let editText = 0;
  let totalText = 0;
  while (count < pending.length && count < MAX_KEYSTROKE_EVENTS_PER_BATCH) {
    const e = pending[count] as PendingEditorEvent;
    if (e.sessionQuestionId !== q) break;
    if (e.atMs - startedAtMs > MAX_KEYSTROKE_OFFSET_MS) break;
    const len = e.kind === 'CURSOR' ? 0 : e.text.length;
    const nextEdit = editText + (e.kind === 'EDIT' ? len : 0);
    const nextTotal = totalText + len;
    if (
      count > 0 &&
      (nextEdit > MAX_KEYSTROKE_BATCH_TEXT || nextTotal > MAX_KEYSTROKE_BATCH_TOTAL_TEXT)
    ) {
      break;
    }
    editText = nextEdit;
    totalText = nextTotal;
    count++;
  }
  const build = (n: number): string =>
    canonicalJson({
      seq,
      sessionQuestionId: q,
      startedAt: new Date(startedAtMs).toISOString(),
      events: pending.slice(0, n).map((e) => withT(e, startedAtMs)),
    });
  let body = build(count);
  while (bodyBytes(body) > MAX_KEYSTROKE_BATCH_BODY_BYTES && count > 1) {
    count = Math.ceil(count / 2);
    body = build(count);
  }
  return { body, consumed: count };
}

/** The keystroke stream: its own sequence, counter key and IndexedDB keys; same guarantees as events. */
export class KeystrokeQueue extends BatchQueue<PendingEditorEvent> {
  constructor(opts: BatchQueueOptions) {
    const spec: BatchQueueSpec<PendingEditorEvent> = {
      keyInfix: 'ks:',
      metaName: 'nextKeystrokeSeq',
      backupPrefix: 'codeproctor:keystrokeseq:',
      // Batches go out every ~2 s (ADR 0010); a burst of this many events is cut at once.
      flushAt: MAX_KEYSTROKE_EVENTS_PER_BATCH,
      accept: (item) => {
        const e = item as PendingEditorEvent;
        if (!e || typeof e !== 'object') return null;
        if (typeof e.sessionQuestionId !== 'string' || !UUID.test(e.sessionQuestionId)) return null;
        // A date the batch can carry (toISOString throws outside years 0000-9999 and would stick the stream).
        if (
          typeof e.atMs !== 'number' ||
          !Number.isFinite(e.atMs) ||
          e.atMs < 0 ||
          e.atMs > MAX_ATMS
        ) {
          return null;
        }
        const { sessionQuestionId: _q, atMs: _a, ...rest } = e;
        void _q;
        void _a;
        const parsed = keystrokeEventSchema.safeParse({ ...rest, t: 0 });
        if (!parsed.success) return null;
        // Rebuild from the PARSED result: unknown keys are stripped and nothing the caller smuggled
        // in (extra properties, overridden kind) can be signed.
        const { t: _t, ...clean } = parsed.data;
        void _t;
        return {
          ...clean,
          sessionQuestionId: e.sessionQuestionId,
          atMs: e.atMs,
        };
      },
      cut: cutKeystrokeBatch,
      // Consecutive cursor moves of one question within 250 ms: keep only the newest. Edits and
      // resets are never coalesced.
      coalesce: (last, next) =>
        last.kind === 'CURSOR' &&
        next.kind === 'CURSOR' &&
        last.sessionQuestionId === next.sessionQuestionId &&
        next.atMs - last.atMs < 250,
    };
    super({ ...opts, flushIntervalMs: opts.flushIntervalMs ?? 2000 }, spec);
  }
}
