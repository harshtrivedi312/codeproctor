import { z } from 'zod';
import { MAX_SOURCE_CODE_LENGTH, codeLanguageSchema } from './code-run';
import { batchSeqSchema, clientTimestampSchema } from './events';

/**
 * Editor event contract for POST /candidate/session/keystrokes (FR-608, FR-802, FR-901; ADR 0010 §2).
 *
 * Privacy first: the SDK records editor model changes (what changed in the code, and where the
 * cursor is), never raw key events. There are no key codes, modifier states or text typed outside
 * the editor. Typing-speed analytics (FR-802) use the edit timestamps. Replay (TC-062) rebuilds the
 * code by applying RESET and EDIT events in order, so every change to the editor model must be sent.
 *
 * Signing, canonical JSON and idempotency are the same as event batches (ARC-03, ADR 0005 §3);
 * keystroke `seq` is a separate sequence from event `seq`.
 */

/** Max editor events in one batch (batches are sent every 2 s). */
export const MAX_KEYSTROKE_EVENTS_PER_BATCH = 1000;
/** Max ms offset of an editor event from the batch's `startedAt` (10 minutes). */
export const MAX_KEYSTROKE_OFFSET_MS = 600_000;
/** Max inserted text across one batch; equal to the source code limit. */
export const MAX_KEYSTROKE_BATCH_TEXT = MAX_SOURCE_CODE_LENGTH;
/** Suggested JSON body limit for POST /candidate/session/keystrokes (worst case UTF-8 plus JSON). */
export const MAX_KEYSTROKE_BATCH_BODY_BYTES = 1024 * 1024;

const offsetMsSchema = z.int().min(0).max(MAX_KEYSTROKE_OFFSET_MS);
/** Character offset into the editor model (UTF-16 code units, as Monaco reports them). */
const modelOffsetSchema = z.int().min(0).max(MAX_SOURCE_CODE_LENGTH);
const textSchema = z.string().max(MAX_SOURCE_CODE_LENGTH);

/**
 * The whole model was set: initial load, restore after reload, reset to starter code, or a
 * language switch. Replay starts from the latest RESET.
 */
export const keystrokeResetSchema = z.object({
  kind: z.literal('RESET'),
  t: offsetMsSchema,
  language: codeLanguageSchema,
  text: textSchema,
});

/** An insert, delete or replace: remove `deleteLength` chars at `offset`, then insert `text`. */
export const keystrokeEditSchema = z
  .object({
    kind: z.literal('EDIT'),
    t: offsetMsSchema,
    offset: modelOffsetSchema,
    deleteLength: modelOffsetSchema,
    text: textSchema,
  })
  .refine((e) => e.deleteLength > 0 || e.text.length > 0, 'An edit must change the code.');

/** Cursor move or selection (FR-608 "cursor move"). */
export const keystrokeCursorSchema = z.object({
  kind: z.literal('CURSOR'),
  t: offsetMsSchema,
  offset: modelOffsetSchema,
  selectionLength: modelOffsetSchema.optional(),
});

export const keystrokeEventSchema = z.discriminatedUnion('kind', [
  keystrokeResetSchema,
  keystrokeEditSchema,
  keystrokeCursorSchema,
]);
export type KeystrokeEvent = z.infer<typeof keystrokeEventSchema>;

/**
 * Signed content of one keystroke batch for one question. Maps to `keystroke_batches`
 * (session_id from the candidate token, session_question_id, seq, started_at, events).
 */
export const keystrokeBatchSchema = z
  .object({
    seq: batchSeqSchema,
    sessionQuestionId: z.uuid(),
    /** Client clock for `t = 0`; untrusted (ADR 0001 TB-1). */
    startedAt: clientTimestampSchema,
    events: z.array(keystrokeEventSchema).min(1).max(MAX_KEYSTROKE_EVENTS_PER_BATCH),
  })
  .superRefine((batch, ctx) => {
    let previous = 0;
    let totalText = 0;
    batch.events.forEach((e, i) => {
      if (e.t < previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 't'],
          message: 'Editor events must be in time order.',
        });
      }
      previous = e.t;
      if (e.kind !== 'CURSOR') totalText += e.text.length;
    });
    if (totalText > MAX_KEYSTROKE_BATCH_TEXT) {
      ctx.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Too much inserted text in one batch.',
      });
    }
  });
export type KeystrokeBatch = z.infer<typeof keystrokeBatchSchema>;
