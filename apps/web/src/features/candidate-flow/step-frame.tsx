'use client';
import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { STEP_IDS, STEP_LABELS, type StepId } from './steps';

/** Progress list: text and a check mark, never colour alone. The current step has aria-current. */
export function Stepper({
  current,
  hidden = [],
}: {
  current: StepId;
  /** Steps this candidate does not have (for example the phone camera outside STRICT). */
  hidden?: readonly StepId[];
}): React.JSX.Element {
  const ids = STEP_IDS.filter((id) => !hidden.includes(id) || id === current);
  const index = ids.indexOf(current);
  return (
    <nav aria-label="Progress">
      <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {ids.map((id, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          return (
            <li
              key={id}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex min-h-8 items-center gap-1.5',
                state === 'current' ? 'font-semibold underline underline-offset-4' : '',
                state === 'todo' ? 'text-muted-foreground' : '',
              )}
            >
              <span
                aria-hidden="true"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs"
              >
                {state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span>
                {STEP_LABELS[id]}
                {state === 'done' ? <span className="sr-only"> (completed)</span> : null}
                {state === 'current' ? <span className="sr-only"> (current step)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Wraps one step. The heading takes focus when the step appears, so keyboard and screen-reader
 * users land on the new content (WCAG 2.4.3). The heading is the page's only h1.
 */
export function StepFrame({
  title,
  intro,
  focusKey,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  /** Change this when the screen changes inside one step, to move focus to the heading again. */
  focusKey?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [focusKey]);
  return (
    <section aria-labelledby="step-title" className="space-y-5">
      <h1
        id="step-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
      </h1>
      {intro ? <p className="text-muted-foreground">{intro}</p> : null}
      {children}
    </section>
  );
}

/** Counts down to zero from a number of seconds. Uses wall time, so a slow tab does not drift. */
export function useCountdown(): { secondsLeft: number; start: (seconds: number) => void } {
  const [endsAt, setEndsAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (endsAt === null) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [endsAt]);
  const secondsLeft = endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - now) / 1000));
  const start = React.useCallback((seconds: number) => {
    setNow(Date.now());
    setEndsAt(Date.now() + seconds * 1000);
  }, []);
  return { secondsLeft, start };
}
