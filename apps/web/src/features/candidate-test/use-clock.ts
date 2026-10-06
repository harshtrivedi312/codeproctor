'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { computeClockOffset, remainingMs } from './timer';

/** How often the offset is re-read from /v1/time (FR-505, TC-047). */
export const CLOCK_RESYNC_MS = 60_000;
/** Difference between Date.now and performance.now deltas that counts as an OS clock jump. */
export const CLOCK_DRIFT_MS = 2_000;
const QUERY_KEY = ['server-time'] as const;

/**
 * Monotonic clock for ticking. The offset is measured against `performance.now()`, not
 * `Date.now()`, so moving the OS clock (TC-047) cannot change the countdown between syncs. The
 * server stays the authority: the offset is re-read from /v1/time every minute and on window
 * focus, and from any response that carries a server time (see `syncFromServer`).
 */
const monotonicNow = (): number => performance.now();

export function useServerClock(readServerNow: () => Promise<string>): {
  ready: boolean;
  remaining: (deadlineIso: string | null | undefined) => number | null;
  /** True when the server time could not be read at all: the screen must not run unchecked. */
  unavailable: boolean;
  retry: () => void;
  /**
   * Re-sync from a server timestamp seen in a response (for example the draft save's `savedAt`).
   * Pass `performance.now()` taken just before the request and just after the response.
   */
  syncFromServer: (serverNowIso: string, requestStart: number, responseEnd: number) => void;
} {
  const queryClient = useQueryClient();
  const {
    data: offset,
    isError,
    refetch,
  } = useQuery({
    queryKey: QUERY_KEY,
    staleTime: CLOCK_RESYNC_MS / 2,
    gcTime: Infinity,
    refetchInterval: CLOCK_RESYNC_MS,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const start = monotonicNow();
      const serverNow = await readServerNow();
      const end = monotonicNow();
      return computeClockOffset(Date.parse(serverNow), start, end);
    },
  });
  const [now, setNow] = React.useState(monotonicNow);
  const lastTick = React.useRef<{ wall: number; mono: number } | null>(null);
  React.useEffect(() => {
    lastTick.current = { wall: Date.now(), mono: monotonicNow() };
    const id = window.setInterval(() => {
      const mono = monotonicNow();
      const wall = Date.now();
      // The OS clock jumped (or the machine slept): the offset is still right because it is
      // monotonic, but ask the server again right away rather than wait for the next minute.
      const last = lastTick.current ?? { wall, mono };
      const drift = wall - last.wall - (mono - last.mono);
      lastTick.current = { wall, mono };
      if (Math.abs(drift) > CLOCK_DRIFT_MS)
        void queryClient.refetchQueries({ queryKey: QUERY_KEY });
      setNow(mono);
    }, 1000);
    return () => window.clearInterval(id);
  }, [queryClient]);
  const syncFromServer = React.useCallback(
    (serverNowIso: string, requestStart: number, responseEnd: number) => {
      const serverNow = Date.parse(serverNowIso);
      if (Number.isNaN(serverNow)) return;
      queryClient.setQueryData(QUERY_KEY, computeClockOffset(serverNow, requestStart, responseEnd));
    },
    [queryClient],
  );
  return {
    ready: offset !== undefined,
    unavailable: offset === undefined && isError,
    retry: () => void refetch(),
    remaining: (deadlineIso) =>
      offset === undefined || !deadlineIso
        ? null
        : remainingMs(Date.parse(deadlineIso), now, offset),
    syncFromServer,
  };
}
