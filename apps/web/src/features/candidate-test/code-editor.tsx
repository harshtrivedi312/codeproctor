'use client';
import Editor, { loader, type OnMount, type BeforeMount } from '@monaco-editor/react';
import type { CodeLanguage } from '@codeproctor/shared';
import type * as MonacoNs from 'monaco-editor';
import * as React from 'react';
import type { KeystrokeRecorder } from '@codeproctor/proctor-sdk';
import { bindKeystrokes, type KeystrokeBinding } from './keystroke-binding';
import { LANGUAGE_KEYWORDS } from './keywords';

// Self-hosted Monaco: files are copied to /public/monaco by scripts/copy-monaco.mjs (no CDN).
loader.config({ paths: { vs: '/monaco/vs' } });

interface JsDefaults {
  setModeConfiguration(config: Record<string, boolean>): void;
}
interface MonacoWithTs {
  typescript?: { javascriptDefaults?: JsDefaults };
  languages: { typescript?: { javascriptDefaults?: JsDefaults } };
}

let configured = false;
const configureOnce: BeforeMount = (monaco: typeof MonacoNs) => {
  if (configured) return;
  configured = true;
  // vs-dark with a brighter comment colour so comments meet WCAG AA contrast on the dark background.
  monaco.editor.defineTheme('codeproctor-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'comment', foreground: '8fc27a' }],
    colors: {},
  });
  // Turn off the TypeScript service completions for JavaScript; keywords only (FR-501).
  const m = monaco as unknown as MonacoWithTs;
  const js = m.typescript?.javascriptDefaults ?? m.languages.typescript?.javascriptDefaults;
  js?.setModeConfiguration({ completionItems: false, hovers: false, signatureHelp: false });
  for (const [language, words] of Object.entries(LANGUAGE_KEYWORDS)) {
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems: (model: MonacoNs.editor.ITextModel, position: MonacoNs.Position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: words.map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: label,
            range,
          })),
        };
      },
    });
  }
};

export interface CodeEditorProps {
  questionId: string;
  language: CodeLanguage;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  /** Called when a paste or drop is blocked, so the screen can tell the candidate. */
  onBlocked: (kind: 'paste' | 'drop') => void;
  /** Every content change (the demo passes no consumer). */
  onContentChange?: (change: { versionId: number; changes: readonly unknown[] }) => void;
  /**
   * The SDK's keystroke recorder, when this editor is the test's answer editor (FR-608, TC-062).
   * Absent for the practice editor and the demo, which never record. A function because the recorder
   * exists only once the proctor session has started.
   */
  getKeystrokes?: () => KeystrokeRecorder | null;
  ariaLabel: string;
}

export default function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const {
    questionId,
    language,
    value,
    readOnly,
    onChange,
    onBlocked,
    onContentChange,
    getKeystrokes,
    ariaLabel,
  } = props;
  const blockedRef = React.useRef(onBlocked);
  const contentRef = React.useRef(onContentChange);
  React.useEffect(() => {
    blockedRef.current = onBlocked;
    contentRef.current = onContentChange;
  });

  // The keystroke binding reads these through refs, updated in a layout effect so they are fresh
  // when Monaco swaps its model for a new question or language (its own effect runs after this).
  const keystrokesRef = React.useRef(getKeystrokes);
  const contextRef = React.useRef({ sessionQuestionId: questionId, language });
  const bindingRef = React.useRef<KeystrokeBinding | null>(null);
  React.useLayoutEffect(() => {
    keystrokesRef.current = getKeystrokes;
    contextRef.current = { sessionQuestionId: questionId, language };
  });
  React.useEffect(() => {
    // After Monaco swapped its model: re-check the recording against the new question and language.
    bindingRef.current?.sync();
  }, [questionId, language, getKeystrokes]);

  // Everything attached in onMount is released on unmount.
  const disposers = React.useRef<Array<() => void>>([]);
  React.useEffect(
    () => () => {
      for (const dispose of disposers.current) dispose();
      disposers.current = [];
    },
    [],
  );

  const onMount: OnMount = (editor) => {
    const dom = editor.getDomNode();
    const block = (kind: 'paste' | 'drop') => (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      blockedRef.current(kind);
    };
    const listen = (type: string, handler: (event: Event) => void) => {
      dom?.addEventListener(type, handler, true);
      disposers.current.push(() => dom?.removeEventListener(type, handler, true));
    };
    listen('paste', block('paste'));
    listen('drop', block('drop'));
    listen('dragover', (e) => e.preventDefault());
    // Safety net: if Monaco still applies a paste, revert it.
    const paste = editor.onDidPaste(() => {
      editor.trigger('paste-guard', 'undo', null);
      blockedRef.current('paste');
    });
    disposers.current.push(() => paste.dispose());
    const content = editor.onDidChangeModelContent((e) => {
      contentRef.current?.({ versionId: e.versionId, changes: e.changes });
    });
    disposers.current.push(() => content.dispose());
    if (keystrokesRef.current) {
      const binding = bindKeystrokes(
        editor,
        () => keystrokesRef.current?.() ?? null,
        () => contextRef.current,
      );
      bindingRef.current = binding;
      disposers.current.push(() => {
        binding.dispose();
        bindingRef.current = null;
      });
    }
  };

  return (
    <Editor
      height="100%"
      path={`${questionId}.${language}`}
      language={language}
      value={value}
      theme="codeproctor-dark"
      beforeMount={configureOnce}
      onMount={onMount}
      onChange={(v) => onChange(v ?? '')}
      loading={<p className="p-4 text-sm text-neutral-200">Loading the editor…</p>}
      options={{
        readOnly,
        ariaLabel,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
        scrollBeyondLastLine: false,
        contextmenu: false,
        dragAndDrop: false,
        dropIntoEditor: { enabled: false },
        inlineSuggest: { enabled: false },
        quickSuggestions: { other: true, comments: false, strings: false },
        wordBasedSuggestions: 'off',
        snippetSuggestions: 'none',
        parameterHints: { enabled: false },
        suggestOnTriggerCharacters: false,
        tabSize: 4,
        accessibilitySupport: 'auto',
      }}
    />
  );
}
