'use client';
import * as React from 'react';

/*
 * Monaco for the question editor (starter code, reference solutions, AI solutions). Self-hosted
 * from /monaco like the candidate screen (no CDN). This is the author's editor, so paste is
 * allowed; Monaco has no AI completions of its own. The module loads lazily, and only in the
 * browser: Monaco touches `window`.
 */
const Inner = React.lazy(() => import('./monaco-inner'));

/**
 * The model-path prefix of one editor mount: `q/<question id>/<nonce>`. Every Monaco model of that
 * editor lives under it, so one question's or one session's code can never reuse another's model,
 * and the whole set can be disposed by prefix (monaco-registry.ts).
 */
export const MonacoScope = React.createContext<string | null>(null);

export interface MonacoFieldProps {
  /** Unique per field inside the editor. */
  path: string;
  language: 'python' | 'javascript' | 'java';
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  ariaLabel: string;
  height?: string;
}

export function MonacoField(props: MonacoFieldProps): React.JSX.Element {
  const scope = React.useContext(MonacoScope);
  // A field outside an editor scope still gets a private path.
  const [own] = React.useState(() => `q/standalone/${Math.random().toString(36).slice(2, 10)}`);
  const path = `${scope ?? own}/${props.path}`;
  return (
    <div
      className="overflow-hidden rounded-md border"
      style={{ height: props.height ?? '280px' }}
      data-testid="code-field"
    >
      <React.Suspense
        fallback={<p className="p-3 text-sm text-muted-foreground">Loading the editor…</p>}
      >
        <Inner {...props} path={path} />
      </React.Suspense>
    </div>
  );
}
