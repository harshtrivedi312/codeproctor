import {
  editsFromMonaco,
  type KeystrokeRecorder,
  type MonacoContentChange,
} from '@codeproctor/proctor-sdk';
import type { CodeLanguage } from '@codeproctor/shared';

/**
 * Binds a Monaco editor to the SDK's keystroke recorder (FR-608, TC-062, FR-802).
 *
 * Written against the few Monaco members it uses, so it is tested without Monaco. Rules from the
 * SDK: every model change is recorded, in order, or replay diverges; offsets and the text given to
 * reset() use the model's own line endings (`model.getValue()` and `getOffsetAt`); the editor text
 * is never logged, never put in an error and never kept anywhere but the recorder.
 *
 * - `reset(questionId, language, text)` on load, on a model swap (question or language switch), when
 *   the whole model is set (`isFlush`), and when the recorder first becomes available.
 * - A change that arrives before the recorder is in sync with the model is not recorded as an edit:
 *   the reset that follows already carries the model as it is now.
 * - The practice editor passes no recorder, so it never records.
 */
export interface BindablePosition {
  readonly lineNumber: number;
  readonly column: number;
}
interface Disposable {
  dispose(): void;
}
export interface BindableModel {
  getValue(): string;
  getOffsetAt(position: BindablePosition): number;
}
export interface BindableEditor {
  getModel(): BindableModel | null;
  onDidChangeModelContent(
    listener: (e: {
      readonly changes: readonly MonacoContentChange[];
      readonly isFlush: boolean;
    }) => void,
  ): Disposable;
  onDidChangeCursorSelection(
    listener: (e: {
      readonly selection: {
        getStartPosition(): BindablePosition;
        getEndPosition(): BindablePosition;
      };
    }) => void,
  ): Disposable;
}

export interface KeystrokeContext {
  /** The session question id (the id the answers routes use). */
  sessionQuestionId: string;
  language: CodeLanguage;
}

export interface KeystrokeBinding {
  /** Re-checks the editor against the context and the recorder; resets the recording if they moved. */
  sync(): void;
  /**
   * The app is about to put `text` into the model itself (reset to starter code, a restored draft):
   * the content event that does it is recorded as a RESET, not as one large edit the candidate never
   * typed (FR-802 would read a whole-file insert as a paste). Cleared by the next content event.
   */
  expectExternalText(text: string): void;
  dispose(): void;
}

export function bindKeystrokes(
  editor: BindableEditor,
  getRecorder: () => KeystrokeRecorder | null,
  getContext: () => KeystrokeContext,
): KeystrokeBinding {
  let synced: {
    recorder: KeystrokeRecorder;
    model: BindableModel;
    sessionQuestionId: string;
    language: CodeLanguage;
  } | null = null;

  const inSync = (): boolean => {
    const recorder = getRecorder();
    const model = editor.getModel();
    const ctx = getContext();
    return (
      synced !== null &&
      recorder === synced.recorder &&
      model === synced.model &&
      ctx.sessionQuestionId === synced.sessionQuestionId &&
      ctx.language === synced.language
    );
  };

  let externalText: string | null = null;

  const reset = (): void => {
    const recorder = getRecorder();
    const model = editor.getModel();
    if (!recorder || !model) {
      synced = null;
      return;
    }
    const ctx = getContext();
    recorder.reset(ctx.sessionQuestionId, ctx.language, model.getValue());
    synced = { recorder, model, ...ctx };
  };

  const content = editor.onDidChangeModelContent((e) => {
    const expected = externalText;
    externalText = null;
    if (expected !== null && editor.getModel()?.getValue() === expected) {
      reset(); // the app set the text itself
      return;
    }
    if (e.isFlush || !inSync()) {
      // The whole model was set, or the recording was not in sync with it: the reset carries the
      // model as it is now, so this change is not also recorded as an edit.
      reset();
      return;
    }
    synced?.recorder.recordChanges(editsFromMonaco(e.changes));
  });
  const cursor = editor.onDidChangeCursorSelection((e) => {
    if (!inSync()) {
      reset();
      return;
    }
    const current = synced;
    if (!current) return;
    current.recorder.recordSelection(
      current.model.getOffsetAt(e.selection.getStartPosition()),
      current.model.getOffsetAt(e.selection.getEndPosition()),
    );
  });

  reset();
  return {
    sync(): void {
      if (!inSync()) reset();
    },
    expectExternalText(text: string): void {
      externalText = text;
    },
    dispose(): void {
      content.dispose();
      cursor.dispose();
      synced = null;
    },
  };
}
