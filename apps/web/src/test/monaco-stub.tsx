import * as React from 'react';

/** Stand-in for Monaco in jsdom: a plain textarea with the same props the question editor passes. */
export function MonacoStub(props: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  ariaLabel: string;
  path?: string;
}): React.JSX.Element {
  return (
    <textarea
      aria-label={props.ariaLabel}
      data-path={props.path}
      value={props.value}
      readOnly={props.readOnly ?? false}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/** Used as: vi.mock('@/features/questions/monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule()) */
export function monacoModule() {
  return { default: MonacoStub };
}
