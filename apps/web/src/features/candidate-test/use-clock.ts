'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { api } from '@/lib/api/client';
import { computeClockOffset, remainingMs } from './timer';

/** Seeds the offset once from /v1/time, then ticks locally every second. */
export function useServerClock(): {
  ready: boolean;
  remaining: (deadlineIso: string | null | undefined) => number | null;
} {
  const { data: offset } = useQuery({
    queryKey: ['server-time'],
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const start = Date.now();
      const { data, error } = await api.GET('/v1/time');
      const end = Date.now();
      if (error || !data) throw new Error('Could not read the server time');
      return computeClockOffset(Date.parse(data.serverNow), start, end);
    },
  });
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return {
    ready: offset !== undefined,
    remaining: (deadlineIso) =>
      offset === undefined || !deadlineIso
        ? null
        : remainingMs(Date.parse(deadlineIso), now, offset),
  };
}
