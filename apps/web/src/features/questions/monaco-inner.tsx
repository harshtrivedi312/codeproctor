'use client';
import Editor, { loader } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import type { MonacoFieldProps } from './monaco-field';

// Same self-hosted files as the candidate editor (scripts/copy-monaco.mjs); setting it twice is harmless.
loader.config({ paths: { vs: '/monaco/vs' } });

export default function MonacoInner({
  path,
  language,
  value,
  onChange,
  readOnly = false,
  ariaLabel,
}: MonacoFieldProps): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      value={value}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
      onChange={(v) => onChange(v ?? '')}
      loading={<p className="p-3 text-sm text-muted-foreground">Loading the editor…</p>}
      options={{
        readOnly,
        ariaLabel,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        tabSize: 4,
        inlineSuggest: { enabled: false },
        accessibilitySupport: 'auto',
      }}
    />
  );
}
