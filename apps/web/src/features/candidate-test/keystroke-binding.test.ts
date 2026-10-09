import type { KeystrokeRecorder } from '@codeproctor/proctor-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindKeystrokes,
  type BindableEditor,
  type BindablePosition,
  type KeystrokeContext,
} from './keystroke-binding';

/** The few Monaco members the binding uses, with listeners the test can fire. */
function fakeEditor(initial = 'x = 1\n') {
  let text = initial;
  let model = {
    getValue: () => text,
    // One offset per line is enough for the test: line n starts at (n - 1) * 100.
    getOffsetAt: (p: BindablePosition) => (p.lineNumber - 1) * 100 + p.column - 1,
  };
  const contentListeners = new Set<Parameters<BindableEditor['onDidChangeModelContent']>[0]>();
  const cursorListeners = new Set<Parameters<BindableEditor['onDidChangeCursorSelection']>[0]>();
  const editor: BindableEditor = {
    getModel: () => model,
    onDidChangeModelContent: (l) => {
      contentListeners.add(l);
      return { dispose: () => void contentListeners.delete(l) };
    },
    onDidChangeCursorSelection: (l) => {
      cursorListeners.add(l);
      return { dispose: () => void cursorListeners.delete(l) };
    },
  };
  return {
    editor,
    setText(next: string) {
      text = next;
    },
    swapModel(next: string) {
      text = next;
      model = { ...model };
    },
    change(changes: { rangeOffset: number; rangeLength: number; text: string }[], isFlush = false) {
      for (const l of contentListeners) l({ changes, isFlush });
    },
    select(start: BindablePosition, end: BindablePosition) {
      for (const l of cursorListeners)
        l({ selection: { getStartPosition: () => start, getEndPosition: () => end } });
    },
    listeners: () => contentListeners.size + cursorListeners.size,
  };
}

function fakeRecorder() {
  return {
    reset: vi.fn(() => true),
    recordChanges: vi.fn(),
    recordSelection: vi.fn(),
  };
}
const asRecorder = (r: ReturnType<typeof fakeRecorder>): KeystrokeRecorder =>
  r as unknown as KeystrokeRecorder;

const Q1 = '3f0e2a7c-6a52-4d5b-9a53-7e9b6a1c2d10';
const Q2 = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

afterEach(() => vi.restoreAllMocks());

describe('Monaco keystroke binding (FR-608, TC-062, FR-802)', () => {
  it('TC-062 FR-608: mounting resets the recording with the model as it is', () => {
    const e = fakeEditor('print(1)\n');
    const r = fakeRecorder();
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    expect(r.reset).toHaveBeenCalledTimes(1);
    expect(r.reset).toHaveBeenCalledWith(Q1, 'python', 'print(1)\n');
  });

  it('TC-062 FR-608: every content change is recorded, highest offset first, as one event', () => {
    const e = fakeEditor();
    const r = fakeRecorder();
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    e.change([
      { rangeOffset: 1, rangeLength: 0, text: 'a' },
      { rangeOffset: 5, rangeLength: 2, text: 'bc' },
    ]);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
    expect(r.recordChanges).toHaveBeenCalledWith([
      { offset: 5, deleteLength: 2, text: 'bc' },
      { offset: 1, deleteLength: 0, text: 'a' },
    ]);
  });

  it('TC-062 FR-608: setting the whole model (isFlush) is a reset, not an edit', () => {
    const e = fakeEditor();
    const r = fakeRecorder();
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    e.setText('fresh start\n');
    e.change([{ rangeOffset: 0, rangeLength: 6, text: 'fresh start\n' }], true);
    expect(r.reset).toHaveBeenLastCalledWith(Q1, 'python', 'fresh start\n');
    expect(r.recordChanges).not.toHaveBeenCalled();
  });

  it('FR-608: cursor and selection moves are recorded with the model offsets', () => {
    const e = fakeEditor();
    const r = fakeRecorder();
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    e.select({ lineNumber: 2, column: 5 }, { lineNumber: 1, column: 3 });
    expect(r.recordSelection).toHaveBeenCalledWith(104, 2);
  });

  it('TC-062 FR-608: a question or language switch resets the recording with the new context and the current text', () => {
    const e = fakeEditor('one\n');
    const r = fakeRecorder();
    let ctx: KeystrokeContext = { sessionQuestionId: Q1, language: 'python' };
    const binding = bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ctx,
    );
    ctx = { sessionQuestionId: Q2, language: 'python' };
    e.swapModel('two\n');
    binding.sync();
    expect(r.reset).toHaveBeenLastCalledWith(Q2, 'python', 'two\n');
    ctx = { sessionQuestionId: Q2, language: 'javascript' };
    e.swapModel('js\n');
    binding.sync();
    expect(r.reset).toHaveBeenLastCalledWith(Q2, 'javascript', 'js\n');
    // Nothing moved: sync does nothing.
    const calls = r.reset.mock.calls.length;
    binding.sync();
    expect(r.reset).toHaveBeenCalledTimes(calls);
  });

  it('TC-062 FR-608: a change that arrives before the recording is in sync is carried by the reset, not recorded twice', () => {
    const e = fakeEditor('a\n');
    const r = fakeRecorder();
    let ctx: KeystrokeContext = { sessionQuestionId: Q1, language: 'python' };
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ctx,
    );
    // The question changed under the editor and the change event came first.
    ctx = { sessionQuestionId: Q2, language: 'python' };
    e.setText('b\n');
    e.change([{ rangeOffset: 0, rangeLength: 1, text: 'b' }]);
    expect(r.reset).toHaveBeenLastCalledWith(Q2, 'python', 'b\n');
    expect(r.recordChanges).not.toHaveBeenCalled();
    // The next change is recorded normally.
    e.change([{ rangeOffset: 1, rangeLength: 0, text: 'c' }]);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
  });

  it('FR-608: with no recorder (before the session started) nothing is recorded; once it exists the next event resets', () => {
    const e = fakeEditor('code\n');
    const r = fakeRecorder();
    let available = false;
    bindKeystrokes(
      e.editor,
      () => (available ? asRecorder(r) : null),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    e.change([{ rangeOffset: 0, rangeLength: 0, text: 'x' }]);
    expect(r.reset).not.toHaveBeenCalled();
    available = true;
    e.change([{ rangeOffset: 1, rangeLength: 0, text: 'y' }]);
    expect(r.reset).toHaveBeenCalledWith(Q1, 'python', 'code\n');
    expect(r.recordChanges).not.toHaveBeenCalled();
    e.change([{ rangeOffset: 2, rangeLength: 0, text: 'z' }]);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
  });

  it('FR-802 FR-608: text the app sets itself (reset to starter code) is a reset, not one big edit', () => {
    const e = fakeEditor('my answer\n');
    const r = fakeRecorder();
    const binding = bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    binding.expectExternalText('# starter\n');
    e.setText('# starter\n');
    e.change([{ rangeOffset: 0, rangeLength: 10, text: '# starter\n' }]);
    expect(r.reset).toHaveBeenLastCalledWith(Q1, 'python', '# starter\n');
    expect(r.recordChanges).not.toHaveBeenCalled();
    // Only that one event: the next change is an ordinary edit again.
    e.setText('# starter\nx');
    e.change([{ rangeOffset: 10, rangeLength: 0, text: 'x' }]);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
  });

  it('FR-802 FR-608: a candidate edit after an expected app text that never came is recorded as an edit', () => {
    const e = fakeEditor('a\n');
    const r = fakeRecorder();
    const binding = bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    binding.expectExternalText('never applied\n');
    e.setText('a\nb');
    e.change([{ rangeOffset: 2, rangeLength: 0, text: 'b' }]);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
  });

  it('FR-702 FR-608: after dispose the listeners are gone and nothing more is recorded', () => {
    const e = fakeEditor();
    const r = fakeRecorder();
    const binding = bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    expect(e.listeners()).toBe(2);
    binding.dispose();
    expect(e.listeners()).toBe(0);
    e.change([{ rangeOffset: 0, rangeLength: 0, text: 'x' }]);
    binding.sync();
    expect(r.recordChanges).not.toHaveBeenCalled();
  });

  it('NFR-05: the editor text is never logged', () => {
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
    ];
    const e = fakeEditor('secret answer\n');
    const r = fakeRecorder();
    bindKeystrokes(
      e.editor,
      () => asRecorder(r),
      () => ({ sessionQuestionId: Q1, language: 'python' }),
    );
    e.change([{ rangeOffset: 0, rangeLength: 0, text: 'more secret' }]);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});
