'use client';
import * as React from 'react';

/*
 * Monaco for the question editor (starter code, reference solutions, AI solutions). Self-hosted
 * from /monaco like the candidate screen (no CDN). This is the author's editor, so paste is
 * allowed; Monaco has no AI completions of its own. The module loads lazily, and only in the
 * browser: Monaco touches `window`.
 */
const Inner = React.lazy(() => import('./monaco-inner'));

export interface MonacoFieldProps {
  /** Unique per field: Monaco keeps one model per path. */
  path: string;
  language: 'python' | 'javascript' | 'java';
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  ariaLabel: string;
  height?: string;
}

export function MonacoField(props: MonacoFieldProps): React.JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-md border"
      style={{ height: props.height ?? '280px' }}
      data-testid="code-field"
    >
      <React.Suspense
        fallback={<p className="p-3 text-sm text-muted-foreground">Loading the editor…</p>}
      >
        <Inner {...props} />
      </React.Suspense>
    </div>
  );
}
