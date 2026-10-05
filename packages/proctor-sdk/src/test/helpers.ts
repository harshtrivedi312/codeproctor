import { vi } from 'vitest';
import type { CapabilityFlag, DetectorContext, LockState } from '../core/types';

export interface Recorded {
  type: string;
  payload: unknown;
  options: Record<string, unknown> | undefined;
}

/** A DetectorContext that records what a monitor does. */
export function fakeContext(root: HTMLElement = document.body): {
  ctx: DetectorContext;
  events: Recorded[];
  capabilities: CapabilityFlag[];
  locks: LockState[];
  setConsent(v: boolean): void;
} {
  const events: Recorded[] = [];
  const capabilities: CapabilityFlag[] = [];
  const locks: LockState[] = [];
  let consent = true;
  const ctx: DetectorContext = {
    emit: (type, payload, options) => {
      events.push({ type, payload, options: options as Record<string, unknown> | undefined });
    },
    root,
    setCapability: (f) => capabilities.push(f),
    setLock: (s) => locks.push(s),
    assertConsent: () => {
      if (!consent) throw new Error('consent');
    },
    measure: (_l, fn) => fn(),
    isDisabled: () => false,
  };
  return { ctx, events, capabilities, locks, setConsent: (v) => (consent = v) };
}

export const noop = vi.fn();

/** Base64 of 32 bytes, deterministic. */
export const TEST_KEY_B64 = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)),
);
