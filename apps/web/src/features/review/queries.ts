'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import { BUSY_CODE } from '@/lib/api/busy';
import type { QueueItem, ReviewPlayback, ReviewSession } from './model';

/*
 * Review workspace hooks (FR-901, FR-902) on the PROVISIONAL queue/bundle/playback routes and the
 * contract scoring and verdict routes. Playback urls are NEVER put in the query cache: the player
 * calls fetchPlayback and keeps the answer in component state only.
 */

export const reviewKeys = {
  all: ['review'] as const,
  queue: ['review', 'queue'] as const,
  session: (id: string) => ['review', 'session', id] as const,
};

function fail(response: Response, error: unknown): never {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  throw new ApiFailure(
    response.status,
    text(body.detail) || text(body.message),
    text(body.code) || '',
  );
}

const MAX_PAGES = 40;

/** Every page of the queue; the table filters on the client. */
export function useReviewQueue() {
  return useQuery({
    queryKey: reviewKeys.queue,
    queryFn: async ({ signal }) => {
      const items: QueueItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data, error, response } = await api.GET('/v1/review/queue', {
          params: { query: { pageSize: 100, ...(cursor ? { cursor } : {}) } },
          signal,
        });
        if (!data) fail(response, error);
        items.push(...data.items);
        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }
      return items;
    },
  });
}

export function useReviewSession(id: string) {
  return useQuery({
    queryKey: reviewKeys.session(id),
    queryFn: async ({ signal }): Promise<ReviewSession> => {
      const { data, error, response } = await api.GET('/v1/review/sessions/{sessionId}', {
        params: { path: { sessionId: id } },
        signal,
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

/** One fresh signed url. The caller must not store it beyond its own state. */
export async function fetchPlayback(
  sessionId: string,
  recordingId: string,
): Promise<ReviewPlayback> {
  const { data, error, response } = await api.GET(
    '/v1/review/sessions/{sessionId}/recordings/{recordingId}/playback',
    { params: { path: { sessionId, recordingId } } },
  );
  if (!data) fail(response, error);
  return data;
}

/** 503 that is not BUSY: the storage adapter is not there yet. */
export const isPlaybackUnavailable = (e: unknown): boolean =>
  e instanceof ApiFailure && e.status === 503 && e.code !== BUSY_CODE;

export function useScoreAnswer(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { sessionQuestionId: string; body: Schemas['ScoreAnswer'] }) => {
      const { data, error, response } = await api.PATCH(
        '/v1/review/sessions/{sessionId}/answers/{sessionQuestionId}',
        {
          params: { path: { sessionId, sessionQuestionId: vars.sessionQuestionId } },
          body: vars.body,
        },
      );
      if (!data) fail(response, error);
      return data;
    },
    onMutate: () => getGeneration(),
    onSuccess: (_d, _v, startedIn) => {
      if (startedIn !== getGeneration()) return;
      void qc.invalidateQueries({ queryKey: reviewKeys.session(sessionId) });
      void qc.invalidateQueries({ queryKey: reviewKeys.queue });
    },
  });
}

export function useSetVerdict(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['SetVerdict']) => {
      const { data, error, response } = await api.POST('/v1/review/sessions/{sessionId}/verdict', {
        params: { path: { sessionId } },
        body,
      });
      if (!data) fail(response, error);
      return data;
    },
    onMutate: () => getGeneration(),
    onSuccess: (_d, _v, startedIn) => {
      if (startedIn !== getGeneration()) return;
      void qc.invalidateQueries({ queryKey: reviewKeys.session(sessionId) });
      void qc.invalidateQueries({ queryKey: reviewKeys.queue });
    },
  });
}
