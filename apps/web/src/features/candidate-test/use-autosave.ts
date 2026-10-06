'use client';
import * as React from 'react';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';
export const AUTOSAVE_INTERVAL_MS = 10_000;

/**
 * FR-504: saves the latest value every 10 s when it changed, and on demand (flush, used by Run).
 * Values are compared by identity, so pass a new object for every edit.
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<void>,
  intervalMs: number = AUTOSAVE_INTERVAL_MS,
): { status: SaveStatus; savedAt: Date | null; flush: () => Promise<boolean> } {
  const [lastSaved, setLastSaved] = React.useState<T>(value);
  const [phase, setPhase] = React.useState<'idle' | 'saving' | 'error'>('idle');
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const latest = React.useRef(value);
  const lastSavedRef = React.useRef(value);
  const saveRef = React.useRef(save);
  const inFlight = React.useRef<Promise<boolean> | null>(null);

  React.useEffect(() => {
    saveRef.current = save;
    latest.current = value;
  });

  /**
   * Resolves true when everything the candidate typed so far is saved, false when a save failed.
   * Waits for a save already in flight, then saves again if the value changed meanwhile (FR-504).
   */
  const flush = React.useCallback(async (): Promise<boolean> => {
    for (;;) {
      const pending = inFlight.current;
      if (pending) {
        await pending;
        continue;
      }
      if (Object.is(latest.current, lastSavedRef.current)) return true;
      const toSave = latest.current;
      const attempt = (async (): Promise<boolean> => {
        setPhase('saving');
        try {
          await saveRef.current(toSave);
          lastSavedRef.current = toSave;
          setLastSaved(toSave);
          setSavedAt(new Date());
          setPhase('idle');
          return true;
        } catch {
          setPhase('error');
          return false;
        }
      })();
      inFlight.current = attempt;
      const ok = await attempt;
      // The owner continues first (its await was registered first), so waiters see it cleared.
      inFlight.current = null;
      if (!ok) return false;
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(() => void flush(), intervalMs);
    return () => window.clearInterval(id);
  }, [flush, intervalMs]);

  const status: SaveStatus =
    phase === 'saving'
      ? 'saving'
      : phase === 'error'
        ? 'error'
        : Object.is(value, lastSaved)
          ? 'saved'
          : 'unsaved';
  return { status, savedAt, flush };
}
