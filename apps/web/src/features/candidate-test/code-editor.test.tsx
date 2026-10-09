import type { KeystrokeRecorder } from '@codeproctor/proctor-sdk';
import { render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * CodeEditor wiring (FR-608, TC-062): Monaco itself needs a browser, so @monaco-editor/react is
 * replaced by a stub that mounts a fake editor with the members CodeEditor and the keystroke
 * binding use. What is tested is CodeEditor's own logic: when it binds, what it resets with, and
 * that it cleans up.
 */
interface Pos {
  lineNumber: number;
  column: number;
}
const harness = vi.hoisted(() => {
  type L<T> = (e: T) => void;
  const state = {
    text: 'starter\n',
    // Monaco hands out the same model object until the path changes.
    newModel() {
      return {
        getValue: () => state.text,
        getOffsetAt: (p: { lineNumber: number; column: number }) => p.column - 1,
      };
    },
    model: null as unknown as { getValue(): string; getOffsetAt(p: Pos): number },
    onChange: null as null | ((v: string | undefined) => void),
    content: new Set<L<{ changes: unknown[]; isFlush: boolean; versionId: number }>>(),
    cursor: new Set<L<unknown>>(),
    fire(changes: unknown[], isFlush = false) {
      for (const l of state.content) l({ changes, isFlush, versionId: 1 });
    },
    reset() {
      state.text = 'starter\n';
      state.model = state.newModel();
      state.content.clear();
      state.cursor.clear();
    },
  };
  state.model = state.newModel();
  return state;
});

vi.mock('@monaco-editor/react', () => {
  const Editor = (props: {
    path?: string;
    value?: string;
    onChange?: (v: string | undefined) => void;
    onMount?: (editor: unknown) => void;
  }): React.JSX.Element => {
    harness.onChange = props.onChange ?? null;
    const mounted = React.useRef(false);
    const lastPath = React.useRef(props.path);
    // A new path is a new model in Monaco; its text starts as the value prop.
    if (lastPath.current !== props.path) {
      lastPath.current = props.path;
      harness.model = harness.newModel();
      harness.text = props.value ?? '';
    }
    React.useEffect(() => {
      if (mounted.current) return;
      mounted.current = true;
      harness.text = props.value ?? '';
      const dom = document.createElement('div');
      props.onMount?.({
        getDomNode: () => dom,
        onDidPaste: () => ({ dispose: () => undefined }),
        trigger: () => undefined,
        getModel: () => harness.model,
        onDidChangeModelContent: (l: never) => {
          harness.content.add(l);
          return { dispose: () => harness.content.delete(l) };
        },
        onDidChangeCursorSelection: (l: never) => {
          harness.cursor.add(l);
          return { dispose: () => harness.cursor.delete(l) };
        },
      });
    }, [props]);
    return <div data-testid="monaco-stub" />;
  };
  return { default: Editor, loader: { config: vi.fn() } };
});

import CodeEditor from './code-editor';

const Q1 = '3f0e2a7c-6a52-4d5b-9a53-7e9b6a1c2d10';
const Q2 = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function recorder() {
  return {
    reset: vi.fn(() => true),
    recordChanges: vi.fn(),
    recordSelection: vi.fn(),
  };
}
const asRecorder = (r: ReturnType<typeof recorder>): KeystrokeRecorder =>
  r as unknown as KeystrokeRecorder;

const base = {
  questionId: Q1,
  language: 'python' as const,
  value: 'starter\n',
  readOnly: false,
  onChange: vi.fn(),
  onBlocked: vi.fn(),
  ariaLabel: 'Code editor',
};

afterEach(() => harness.reset());

describe('CodeEditor keystroke wiring (FR-608, TC-062)', () => {
  it('FR-406 FR-608: without a recorder (the practice editor, the demo) nothing is bound', () => {
    render(<CodeEditor {...base} />);
    expect(harness.cursor.size).toBe(0);
  });

  it('TC-062 FR-608: with a recorder the editor resets the recording on mount and binds change and cursor events', () => {
    const r = recorder();
    render(<CodeEditor {...base} getKeystrokes={() => asRecorder(r)} />);
    expect(r.reset).toHaveBeenCalledWith(Q1, 'python', 'starter\n');
    expect(harness.cursor.size).toBe(1);
    harness.text = 'starter\nx';
    harness.fire([{ rangeOffset: 8, rangeLength: 0, text: 'x' }]);
    expect(r.recordChanges).toHaveBeenCalledWith([{ offset: 8, deleteLength: 0, text: 'x' }]);
  });

  it('TC-062 FR-608: a question switch resets the recording with the new question id and the new model text', () => {
    const r = recorder();
    const { rerender } = render(<CodeEditor {...base} getKeystrokes={() => asRecorder(r)} />);
    rerender(
      <CodeEditor
        {...base}
        questionId={Q2}
        value={'second\n'}
        getKeystrokes={() => asRecorder(r)}
      />,
    );
    expect(r.reset).toHaveBeenLastCalledWith(Q2, 'python', 'second\n');
  });

  it('TC-062 FR-608: a language switch resets the recording with the new language', () => {
    const r = recorder();
    const { rerender } = render(<CodeEditor {...base} getKeystrokes={() => asRecorder(r)} />);
    rerender(
      <CodeEditor
        {...base}
        language="javascript"
        value={'// js\n'}
        getKeystrokes={() => asRecorder(r)}
      />,
    );
    expect(r.reset).toHaveBeenLastCalledWith(Q1, 'javascript', '// js\n');
  });

  it('FR-802 FR-608: a reset to starter code is recorded as a RESET, not one big edit', () => {
    const r = recorder();
    const get = () => asRecorder(r);
    const typed = 'starter\nmy code';
    const { rerender } = render(<CodeEditor {...base} value={'starter\n'} getKeystrokes={get} />);
    // The candidate types: Monaco reports the change and onChange, and the parent echoes the text.
    harness.text = typed;
    harness.fire([{ rangeOffset: 8, rangeLength: 0, text: 'my code' }]);
    harness.onChange?.(typed);
    rerender(<CodeEditor {...base} value={typed} getKeystrokes={get} />);
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
    // The app resets the text (the value prop is not what the editor last reported).
    rerender(<CodeEditor {...base} value={'starter\n'} getKeystrokes={get} />);
    harness.text = 'starter\n';
    harness.fire([{ rangeOffset: 0, rangeLength: 15, text: 'starter\n' }]);
    expect(r.reset).toHaveBeenLastCalledWith(Q1, 'python', 'starter\n');
    expect(r.recordChanges).toHaveBeenCalledTimes(1);
  });

  it('FR-608: a recorder that appears after the editor mounted is bound then', () => {
    const r = recorder();
    const { rerender } = render(<CodeEditor {...base} />);
    expect(harness.cursor.size).toBe(0);
    rerender(<CodeEditor {...base} getKeystrokes={() => asRecorder(r)} />);
    expect(harness.cursor.size).toBe(1);
    expect(r.reset).toHaveBeenCalledWith(Q1, 'python', 'starter\n');
  });

  it('FR-702 FR-608: leaving the page unbinds the editor', () => {
    const r = recorder();
    const { unmount } = render(<CodeEditor {...base} getKeystrokes={() => asRecorder(r)} />);
    expect(harness.cursor.size).toBe(1);
    unmount();
    expect(harness.cursor.size).toBe(0);
    expect(harness.content.size).toBe(0);
  });
});
