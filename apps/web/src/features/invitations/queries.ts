'use client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { testKeys } from '@/features/tests/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import type { CsvRowInput } from './csv';
import { problemWords } from './outcome';

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
    // The variables hold a name, an email and accommodations (a waiver note is health-adjacent):
    // do not keep them in the cache after the call.
    gcTime: 0,
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
      invalidateAfterInvite(qc, vars.testId, startedIn);
    },
  });
}

/** The candidate list, the tests list and the test (it is now "in use") are stale after an invite. */
export function invalidateAfterInvite(qc: QueryClient, testId: string, startedIn: number): void {
  if (startedIn !== getGeneration()) return;
  void qc.invalidateQueries({ queryKey: ['admin', 'candidates'] });
  void qc.invalidateQueries({ queryKey: testKeys.list });
  void qc.invalidateQueries({ queryKey: testKeys.detail(testId) });
}

export interface BulkOutcome {
  /** Rows sent so far that were accepted. */
  created: number;
  /** Rows that were invited but whose email was not queued (the rows' CSV numbers). */
  mailNotSent: { row: number; mail: 'failed' | 'disabled' }[];
  /** Rows the server refused, by the row number of the CSV (not the request) and reason. */
  errors: { row: number; message: string }[];
  /** Rows not sent because the hourly limit stopped the upload. */
  notSent: number;
  /** The rows from the first unsent chunk on, in file order, so they can be downloaded and sent again. */
  unsentRows: CsvRowInput[];
  /** Of `notSent`: rows in a request whose answer never arrived, so they may have been invited. */
  uncertain: number;
  /** The upload was stopped here (dialog closed or session changed), not by the server. */
  stopped: boolean;
  /** Seconds the server asked to wait, when it stopped us. */
  retryAfterSeconds: number | null;
  /** The upload stopped on a failure other than the limit. */
  failed: InviteFailure | null;
}

/** The API refuses a start more than 5 minutes in the past; refresh the window well before that. */
export const WINDOW_REFRESH_MS = 3 * 60_000;

/** Requests in flight at once during a CSV upload. Small: the API limits invitations per hour. */
export const BULK_CONCURRENCY = 4;

/**
 * Sends the valid rows as single invitations (the API has no bulk route), at most
 * BULK_CONCURRENCY at a time, and merges the answers per row. A 429, a 5xx, a lost connection or a
 * failure that would hit every row (401, 403, 404, 422, a bad window) stops the upload: no new row
 * is started, rows already invited stay invited, and the rows not confirmed are reported (and
 * returned in file order so they can be downloaded). A 5xx or lost connection is never retried
 * (the invitation may exist): those rows count as uncertain. `signal.aborted` and a changed
 * session stop it too. Nothing here is silent: every row ends created, refused or not sent.
 */
export async function inviteInChunks(
  testId: string,
  rows: readonly CsvRowInput[],
  window: { windowStart: string; windowEnd: string },
  /**
   * `followClock`: the start was not chosen by the user (untouched or clamped to now). A long upload
   * must not outlive the API's "start at most 5 minutes in the past" rule, so once the cached start
   * is older than WINDOW_REFRESH_MS the whole window is shifted by the time elapsed (same length).
   * A start the user chose is kept; only if it went stale it moves to now and the end stays.
   */
  followClock: boolean,
  onProgress?: (sent: number) => void,
  signal?: { aborted: boolean },
): Promise<BulkOutcome> {
  const startedIn = getGeneration();
  const out: BulkOutcome = {
    created: 0,
    mailNotSent: [],
    errors: [],
    notSent: 0,
    unsentRows: [],
    uncertain: 0,
    stopped: false,
    retryAfterSeconds: null,
    failed: null,
  };
  const t0 = Date.now();
  const start0 = Date.parse(window.windowStart);
  const end0 = Date.parse(window.windowEnd);
  const windowNow = (): { windowStart: string; windowEnd: string } => {
    const now = Date.now();
    if (now - t0 < WINDOW_REFRESH_MS) return window;
    if (followClock) {
      const shift = now - t0;
      return {
        windowStart: new Date(start0 + shift).toISOString(),
        windowEnd: new Date(end0 + shift).toISOString(),
      };
    }
    return start0 < now - WINDOW_REFRESH_MS
      ? { windowStart: new Date(now).toISOString(), windowEnd: window.windowEnd }
      : window;
  };
  const settled = new Set<number>();
  const uncertainAt = new Set<number>();
  let next = 0;
  let halted = false;
  let done = 0;

  const sendRow = async (at: number): Promise<void> => {
    const row = rows[at] as CsvRowInput;
    try {
      const { data, error, response } = await api.POST('/v1/tests/{testId}/invitations', {
        params: { path: { testId } },
        // Only the fields the API's DTO accepts: externalRef and accommodations would be a 400.
        body: { candidate: { email: row.email, name: row.name }, ...windowNow() },
      });
      if (!data) failFrom(response, error);
      settled.add(at);
      out.created += 1;
      if (data.mail !== 'queued') {
        out.mailNotSent.push({
          row: row.row,
          mail: data.mail === 'disabled' ? 'disabled' : 'failed',
        });
      }
      done += 1;
      onProgress?.(done);
    } catch (e) {
      if (e instanceof InviteFailure) {
        const rowOnly =
          e.status === 409 ||
          (e.status === 400 && !e.errors.some((m) => /^window/i.test(m)) && rowFault(e));
        if (rowOnly) {
          settled.add(at);
          out.errors.push({ row: row.row, message: failureWords(e) });
          done += 1;
          onProgress?.(done);
          return;
        }
        halted = true;
        if (e.status === 429) out.retryAfterSeconds ??= e.retryAfterSeconds;
        else {
          out.failed ??= e;
          if (e.status >= 500) uncertainAt.add(at);
        }
        return;
      }
      // No answer: the request may or may not have been applied.
      halted = true;
      out.failed ??= new InviteFailure(0, '', '', [], null);
      uncertainAt.add(at);
    }
  };

  const worker = async (): Promise<void> => {
    while (!halted) {
      if (signal?.aborted || startedIn !== getGeneration()) {
        halted = true;
        out.stopped = true;
        return;
      }
      const at = next;
      next += 1;
      if (at >= rows.length) return;
      await sendRow(at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, rows.length) }, worker));

  out.unsentRows = rows.filter((_, at) => !settled.has(at));
  out.notSent = out.unsentRows.length;
  out.uncertain = uncertainAt.size;
  return out;
}

/** A 400 that names the candidate's fields is about this row only. */
const rowFault = (e: InviteFailure): boolean => e.errors.some((m) => /^candidate/i.test(m));

/** The API's own words for a refused row. */
function failureWords(e: InviteFailure): string {
  return problemWords(e.message, e.errors) || 'The server did not accept this row.';
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
