'use client';
import Editor, { loader, type BeforeMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { useTheme } from 'next-themes';
import * as React from 'react';
import type { MonacoFieldProps } from './monaco-field';
import { disposeModels, registerModelHost } from './monaco-registry';

// Same self-hosted files as the candidate editor (scripts/copy-monaco.mjs); setting it twice is harmless.
loader.config({ paths: { vs: '/monaco/vs' } });

const register: BeforeMount = (monaco: typeof MonacoNs) => registerModelHost(monaco);

export default function MonacoInner({
  path,
  language,
  value,
  onChange,
  readOnly = false,
  ariaLabel,
}: MonacoFieldProps): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  // This field's model goes when the field goes (the editor also disposes the whole scope).
  React.useEffect(() => () => void disposeModels(path), [path]);
  return (
    <Editor
      height="100%"
      path={path}
      beforeMount={register}
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
