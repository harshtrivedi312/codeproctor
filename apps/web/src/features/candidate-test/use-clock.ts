'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { api } from '@/lib/api/client';
import { computeClockOffset, remainingMs } from './timer';

/** How often the offset is re-read from /v1/time (FR-505, TC-047). */
export const CLOCK_RESYNC_MS = 60_000;
const QUERY_KEY = ['server-time'] as const;

/**
 * Monotonic clock for ticking. The offset is measured against `performance.now()`, not
 * `Date.now()`, so moving the OS clock (TC-047) cannot change the countdown between syncs. The
 * server stays the authority: the offset is re-read from /v1/time every minute and on window
 * focus, and from any response that carries a server time (see `syncFromServer`).
 */
const monotonicNow = (): number => performance.now();

export function useServerClock(): {
  ready: boolean;
  remaining: (deadlineIso: string | null | undefined) => number | null;
  /**
   * Re-sync from a server timestamp seen in a response (for example the draft save's `savedAt`).
   * Pass `performance.now()` taken just before the request and just after the response.
   */
  syncFromServer: (serverNowIso: string, requestStart: number, responseEnd: number) => void;
} {
  const queryClient = useQueryClient();
  const { data: offset } = useQuery({
    queryKey: QUERY_KEY,
    staleTime: CLOCK_RESYNC_MS / 2,
    gcTime: Infinity,
    refetchInterval: CLOCK_RESYNC_MS,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const start = monotonicNow();
      const { data, error } = await api.GET('/v1/time');
      const end = monotonicNow();
      if (error || !data) throw new Error('Could not read the server time');
      return computeClockOffset(Date.parse(data.serverNow), start, end);
    },
  });
  const [now, setNow] = React.useState(monotonicNow);
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(monotonicNow()), 1000);
    return () => window.clearInterval(id);
  }, []);
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
    remaining: (deadlineIso) =>
      offset === undefined || !deadlineIso
        ? null
        : remainingMs(Date.parse(deadlineIso), now, offset),
    syncFromServer,
  };
}
