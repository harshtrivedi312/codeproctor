'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { testKeys } from '@/features/tests/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import { BULK_CHUNK, type CsvRowInput } from './csv';

/*
 * Invitation calls: WEB-ONLY and PROVISIONAL [BE-06b] (see docs/followups/frontend.md). Candidate
 * data (names, emails, CSV rows) is never put in a query key, a URL or storage; the candidate's
 * invitations are fetched by id only when a timeline is opened, and the whole cache is cleared on a
 * user or role change (AuthProvider) with every cache write guarded by the session generation.
 */

export const invitationKeys = {
  forCandidate: (candidateId: string) => ['admin', 'candidate-invitations', candidateId] as const,
};

export type CandidateInvitation = Schemas['CandidateInvitation'];

/** A failure with what the caller needs to explain it: status, the problem's words and Retry-After. */
export class InviteFailure extends ApiFailure {
  constructor(
    status: number,
    message: string,
    code: string,
    errors: readonly string[],
    readonly retryAfterSeconds: number | null,
  ) {
    super(status, message, code, errors);
  }
}

function failFrom(response: Response, error: unknown): never {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const errors = Array.isArray(body.errors) ? body.errors.map((e) => text(e)).filter(Boolean) : [];
  const retry = Number(response.headers.get('retry-after'));
  throw new InviteFailure(
    response.status,
    text(body.detail) || text(body.message),
    text(body.code),
    errors,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

export function useInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { testId: string; body: Schemas['CreateInvitation'] }) => {
      const { data, error, response } = await api.POST('/v1/tests/{testId}/invitations', {
        params: { path: { testId: vars.testId } },
        body: vars.body,
      });
      if (!data) return failFrom(response, error);
      return data;
    },
    onMutate: () => getGeneration(),
    onSuccess: (_data, vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      void qc.invalidateQueries({ queryKey: ['admin', 'candidates'] });
      void qc.invalidateQueries({ queryKey: testKeys.list });
      void qc.invalidateQueries({ queryKey: testKeys.detail(vars.testId) });
    },
  });
}

export interface BulkOutcome {
  /** Rows sent so far that were accepted. */
  created: number;
  /** Rows the server refused, by the row number of the CSV (not the request) and reason. */
  errors: { row: number; message: string }[];
  /** Rows not sent because the hourly limit stopped the upload. */
  notSent: number;
  /** Seconds the server asked to wait, when it stopped us. */
  retryAfterSeconds: number | null;
  /** The upload stopped on a failure other than the limit. */
  failed: InviteFailure | null;
}

/**
 * Sends the valid rows in chunks (at most BULK_CHUNK per request) and merges the answers. A 429
 * stops the upload and reports how many rows were not sent; the rows already invited stay invited.
 * `signal.aborted` and a changed session stop it too.
 */
export async function inviteInChunks(
  testId: string,
  rows: readonly CsvRowInput[],
  window: { windowStart: string; windowEnd: string },
  onProgress?: (sent: number) => void,
  signal?: { aborted: boolean },
): Promise<BulkOutcome> {
  const startedIn = getGeneration();
  const out: BulkOutcome = {
    created: 0,
    errors: [],
    notSent: 0,
    retryAfterSeconds: null,
    failed: null,
  };
  for (let at = 0; at < rows.length; at += BULK_CHUNK) {
    if (signal?.aborted || startedIn !== getGeneration()) {
      out.notSent = rows.length - at;
      return out;
    }
    const chunk = rows.slice(at, at + BULK_CHUNK);
    try {
      const { data, error, response } = await api.POST('/v1/tests/{testId}/invitations/bulk', {
        params: { path: { testId } },
        body: {
          ...window,
          rows: chunk.map((r) => ({
            email: r.email,
            name: r.name,
            ...(r.externalRef !== '' ? { externalRef: r.externalRef } : {}),
          })),
        },
      });
      if (!data) return failFrom(response, error);
      out.created += data.created;
      // The server counts rows inside the chunk: map back to the CSV row of that chunk item.
      for (const e of data.errors) {
        const original = chunk[e.row - 1];
        if (original) out.errors.push({ row: original.row, message: e.message });
      }
      onProgress?.(Math.min(at + chunk.length, rows.length));
    } catch (e) {
      out.notSent = rows.length - at;
      if (e instanceof InviteFailure) {
        if (e.status === 429) out.retryAfterSeconds = e.retryAfterSeconds;
        else out.failed = e;
      } else {
        out.failed = new InviteFailure(0, '', '', [], null);
      }
      return out;
    }
  }
  return out;
}

export function useCandidateInvitations(candidateId: string | null) {
  return useQuery({
    queryKey: invitationKeys.forCandidate(candidateId ?? ''),
    enabled: candidateId !== null,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/v1/admin/candidates/{candidateId}/invitations',
        {
          params: { path: { candidateId: candidateId ?? '' } },
        },
      );
      if (!data) return failFrom(response, error);
      return data.items;
    },
  });
}
