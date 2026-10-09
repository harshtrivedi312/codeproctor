import { MAX_SOURCE_CODE_LENGTH, type CodeLanguage } from '@codeproctor/shared';
import type { PendingEditorEvent } from './keystroke-queue';

/** An editor model change: remove `deleteLength` characters at `offset`, then insert `text`. */
export interface EditorChange {
  offset: number;
  deleteLength: number;
  text: string;
}

/**
 * The shape of Monaco's `IModelContentChange` (from `onDidChangeModelContent`), declared here so the
 * SDK does not import monaco. `rangeOffset` and `rangeLength` are UTF-16 code units, like the schema.
 */
export interface MonacoContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * Convert the `changes` of one Monaco content-change event to EditorChange[] ready for
 * `recordChanges`. Monaco reports offsets against the model BEFORE the event, so the changes are
 * ordered from the highest offset down: applied one after the other, an earlier edit never moves
 * the offset of a later one. Replay applies EDIT events in recorded order, so this order matters.
 */
export function editsFromMonaco(changes: readonly MonacoContentChange[]): EditorChange[] {
  return [...changes]
    .sort((a, b) => b.rangeOffset - a.rangeOffset || b.rangeLength - a.rangeLength)
    .map((c) => ({ offset: c.rangeOffset, deleteLength: c.rangeLength, text: c.text }));
}

/** U+0000 and unpaired surrogates cannot be stored by the API (JSON/Postgres), so they cannot be sent. */
function isStorable(text: string): boolean {
  if (text.includes('\u0000')) return false;
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** What the recorder could not represent. Never carries editor text. */
export type UnrepresentableReason =
  | 'TEXT_TOO_LONG'
  | 'OFFSET_TOO_LARGE'
  | 'NO_QUESTION'
  /** U+0000 or a lone surrogate: the API cannot store it and would reject the whole batch. */
  | 'UNSTORABLE_TEXT'
  /** The queue refused the item (invalid shape or the stream is closed). */
  | 'INVALID';

export interface KeystrokeRecorderStats {
  recordedEvents: number;
  /** Events skipped because they cannot be represented (text over 100 000 characters, no reset yet). */
  unrepresentable: number;
}

interface Sink {
  enqueue(item: unknown): boolean;
}

/**
 * Records editor model changes for replay (FR-608, TC-062) and typing analytics (FR-802).
 *
 * Usage from the test screen (Monaco side stays in the app):
 *   recorder.reset(sessionQuestionId, language, model.getValue());          // load, restore, reset, language switch
 *   editor.onDidChangeModelContent((e) => recorder.recordChanges(editsFromMonaco(e.changes)));
 *   editor.onDidChangeCursorSelection((e) => recorder.recordSelection(
 *     model.getOffsetAt(e.selection.getStartPosition()), model.getOffsetAt(e.selection.getEndPosition())));
 *
 * Every change to the editor model must be recorded, in order, or replay diverges. Offsets and the
 * text given to reset() must use the same line endings (the model's EOL, not the DOM's). A question
 * switch is a new `reset()` with the other `sessionQuestionId` (batches never mix questions).
 *
 * Privacy (NFR-05): only model changes; nothing about keys or modifiers; the text is never logged,
 * never put in an error message and never reported through `onUnrepresentable` (reasons only).
 */
export class KeystrokeRecorder {
  private question: string | null = null;
  private lastMs = 0;
  private closed = false;
  private recorded = 0;
  private skipped = 0;
  /** Questions whose model outgrew what the schema can represent, until the next valid reset(). */
  private readonly overflowed = new Set<string>();

  constructor(
    private readonly sink: Sink,
    private readonly now: () => number = Date.now,
    private readonly onUnrepresentable?: (reason: UnrepresentableReason) => void,
  ) {}

  private tick(): number {
    // Non-decreasing even if the system clock steps back (the schema requires ordered `t`).
    this.lastMs = Math.max(this.lastMs, this.now());
    return this.lastMs;
  }

  private skip(reason: UnrepresentableReason): void {
    this.skipped++;
    this.onUnrepresentable?.(reason);
  }

  private push(e: PendingEditorEvent): void {
    if (this.sink.enqueue(e)) this.recorded++;
    else this.skip('INVALID');
  }

  /**
   * The whole model was set: initial load, restore after a reload, reset to starter code, language
   * switch, or switching to another question. Replay starts from the latest RESET. Returns false
   * when the text is longer than MAX_SOURCE_CODE_LENGTH (100 000): the schema cannot carry it, the
   * question is then not recorded until a shorter reset.
   */
  reset(sessionQuestionId: string, language: CodeLanguage, text: string): boolean {
    if (this.closed) return false;
    this.question = sessionQuestionId;
    if (text.length > MAX_SOURCE_CODE_LENGTH) {
      this.overflowed.add(sessionQuestionId);
      this.skip('TEXT_TOO_LONG');
      return false;
    }
    if (!isStorable(text)) {
      this.overflowed.add(sessionQuestionId);
      this.skip('UNSTORABLE_TEXT');
      return false;
    }
    this.overflowed.delete(sessionQuestionId);
    this.push({ sessionQuestionId, atMs: this.tick(), kind: 'RESET', language, text });
    return true;
  }

  /** One change, in the order Monaco applied it. */
  recordChange(change: EditorChange): void {
    if (this.closed) return;
    const q = this.question;
    if (q === null) return this.skip('NO_QUESTION');
    if (this.overflowed.has(q)) return this.skip('TEXT_TOO_LONG');
    if (change.deleteLength === 0 && change.text.length === 0) return; // not a change
    if (
      change.offset > MAX_SOURCE_CODE_LENGTH ||
      change.deleteLength > MAX_SOURCE_CODE_LENGTH ||
      change.text.length > MAX_SOURCE_CODE_LENGTH
    ) {
      // The model has outgrown the schema: replay would diverge, so say so and stop recording
      // this question until the next reset() instead of sending edits that cannot be replayed.
      this.overflowed.add(q);
      return this.skip(
        change.text.length > MAX_SOURCE_CODE_LENGTH ? 'TEXT_TOO_LONG' : 'OFFSET_TOO_LARGE',
      );
    }
    if (!isStorable(change.text)) {
      this.overflowed.add(q); // replay would diverge: stop recording until the next reset()
      return this.skip('UNSTORABLE_TEXT');
    }
    // Explicit fields only: nothing else the caller attached is ever signed.
    this.push({
      sessionQuestionId: q,
      atMs: this.tick(),
      kind: 'EDIT',
      offset: change.offset,
      deleteLength: change.deleteLength,
      text: change.text,
    });
  }

  /** The changes of one Monaco event (use `editsFromMonaco`), all with the same timestamp. */
  recordChanges(changes: readonly EditorChange[]): void {
    for (const c of changes) this.recordChange(c);
  }

  /** Cursor move or selection (FR-608). Rapid consecutive moves (under 250 ms) are coalesced by the queue. */
  recordCursor(offset: number, selectionLength?: number): void {
    if (this.closed) return;
    const q = this.question;
    if (q === null || this.overflowed.has(q)) return;
    if (offset < 0 || offset > MAX_SOURCE_CODE_LENGTH) return;
    const atMs = this.tick();
    const event: PendingEditorEvent = {
      sessionQuestionId: q,
      atMs,
      kind: 'CURSOR',
      offset,
      ...(selectionLength
        ? { selectionLength: Math.min(selectionLength, MAX_SOURCE_CODE_LENGTH) }
        : {}),
    };
    this.push(event); // the queue coalesces rapid consecutive cursor moves
  }

  /** Selection from two model offsets (anchor and active, either order). */
  recordSelection(startOffset: number, endOffset: number): void {
    this.recordCursor(Math.min(startOffset, endOffset), Math.abs(endOffset - startOffset));
  }

  /**
   * Stop recording for good (called by the session on stop() and finish()). The app may keep its
   * reference to the recorder; every method is a no-op afterwards, so editor text recorded after
   * the end of the test can never reach IndexedDB (FR-702).
   */
  close(): void {
    this.closed = true;
  }

  stats(): KeystrokeRecorderStats {
    return { recordedEvents: this.recorded, unrepresentable: this.skipped };
  }
}
