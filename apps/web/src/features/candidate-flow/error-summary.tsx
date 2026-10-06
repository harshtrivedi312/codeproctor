'use client';
import * as React from 'react';

export interface SummaryItem {
  /** The id of the field the message belongs to, so the link can jump to it. */
  fieldId: string;
  message: string;
}

/**
 * A short list of what to fix, announced when it appears and focused after a failed submit
 * (WCAG 3.3.1, 3.3.3). Each item links to its field. Not colour-only: it has a heading and text.
 */
export const ErrorSummary = React.forwardRef<HTMLDivElement, { items: SummaryItem[] }>(
  function ErrorSummary({ items }, ref) {
    if (items.length === 0) return null;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="alert"
        className="rounded-md border border-destructive bg-destructive-soft p-3 text-sm"
      >
        <p className="font-medium">
          There {items.length === 1 ? 'is 1 thing' : `are ${items.length} things`} to fix before you
          can continue
        </p>
        <ul className="mt-1 list-disc pl-5">
          {items.map((item) => (
            <li key={item.fieldId}>
              <a className="underline underline-offset-4" href={`#${item.fieldId}`}>
                {item.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  },
);
