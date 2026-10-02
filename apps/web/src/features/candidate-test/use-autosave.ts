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
): { status: SaveStatus; savedAt: Date | null; flush: () => Promise<void> } {
  const [lastSaved, setLastSaved] = React.useState<T>(value);
  const [phase, setPhase] = React.useState<'idle' | 'saving' | 'error'>('idle');
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const latest = React.useRef(value);
  const lastSavedRef = React.useRef(value);
  const saveRef = React.useRef(save);
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    saveRef.current = save;
    latest.current = value;
  });

  const flush = React.useCallback(async () => {
    if (inFlight.current || Object.is(latest.current, lastSavedRef.current)) return;
    const toSave = latest.current;
    inFlight.current = true;
    setPhase('saving');
    try {
      await saveRef.current(toSave);
      lastSavedRef.current = toSave;
      setLastSaved(toSave);
      setSavedAt(new Date());
      setPhase('idle');
    } catch {
      setPhase('error');
    } finally {
      inFlight.current = false;
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
