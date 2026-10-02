'use client';
import Editor, { loader, type OnMount, type BeforeMount } from '@monaco-editor/react';
import type { CodeLanguage } from '@codeproctor/shared';
import type * as MonacoNs from 'monaco-editor';
import * as React from 'react';
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
  /** Every content change, for keystroke capture (FR-608). The demo passes no consumer. */
  onContentChange?: (change: { versionId: number; changes: readonly unknown[] }) => void;
  ariaLabel: string;
}

export default function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const { questionId, language, value, readOnly, onChange, onBlocked, onContentChange, ariaLabel } =
    props;
  const blockedRef = React.useRef(onBlocked);
  const contentRef = React.useRef(onContentChange);
  React.useEffect(() => {
    blockedRef.current = onBlocked;
    contentRef.current = onContentChange;
  });

  const onMount: OnMount = (editor) => {
    const dom = editor.getDomNode();
    const block = (kind: 'paste' | 'drop') => (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      blockedRef.current(kind);
    };
    dom?.addEventListener('paste', block('paste'), true);
    dom?.addEventListener('drop', block('drop'), true);
    dom?.addEventListener('dragover', (e) => e.preventDefault(), true);
    // Safety net: if Monaco still applies a paste, revert it.
    editor.onDidPaste(() => {
      editor.trigger('paste-guard', 'undo', null);
      blockedRef.current('paste');
    });
    editor.onDidChangeModelContent((e) => {
      contentRef.current?.({ versionId: e.versionId, changes: e.changes });
    });
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
