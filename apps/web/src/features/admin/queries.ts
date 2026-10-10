'use client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type Schemas } from '@/lib/api/client';
import { BUSY_CODE } from '@/lib/api/busy';
import { getGeneration } from '@/lib/auth-session';

/** An API answer that was not 2xx, carrying the status so screens can explain it. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's machine code, when a route defines one (auth routes do; the question routes' 409 and 422 do not). */
    readonly code: string = '',
    /** RFC 7807 `errors[]` strings (409 and 422 bodies carry detail and errors only). */
    readonly errors: readonly string[] = [],
  ) {
    super(message);
  }
}

function fail(response: Response, error: unknown): never {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code =
    error && typeof error === 'object' && 'code' in error && error.code === BUSY_CODE
      ? BUSY_CODE
      : '';
  throw new ApiFailure(response.status, message, code);
}

/** 503 BUSY after the client's own retries: lock contention, the action did not happen. */
export const isBusyFailure = (e: unknown): boolean =>
  e instanceof ApiFailure && e.status === 503 && e.code === BUSY_CODE;

/**
 * What to tell the user when a staff write failed in a way the screen has no special words for.
 * BUSY (after the client's own retries): nothing happened, try again. 500: the action may have
 * happened (the audit row can fail after the commit), so look first. Never retried automatically.
 */
export function writeFailureText(e: unknown, fallback: string): string {
  if (isBusyFailure(e)) {
    return 'The service is busy and nothing was changed. Wait a moment, then try again.';
  }
  if (isServerFailure(e)) {
    return 'Something went wrong. Check the list before trying again: the change may already have happened.';
  }
  return fallback;
}

/** A 500 on a write: the action may have happened (the audit row can fail after the commit). */
export const isServerFailure = (e: unknown): boolean => e instanceof ApiFailure && e.status === 500;

export const adminKeys = {
  users: ['admin', 'users'] as const,
  settings: ['admin', 'settings'] as const,
  consent: ['admin', 'consent-texts'] as const,
  candidates: ['admin', 'candidates'] as const,
  lockEvents: ['admin', 'users', 'lock-events'] as const,
};

/** The API's largest page (docs/api-contract.md section 6: pageSize 1 to 100). */
const USERS_PAGE_SIZE = 100;
/** page * pageSize over 10 000 is a 400, and a staff list that long is not a real list. */
const USERS_MAX_PAGES = 10;

/**
 * Reads the staff user list page by page (the API pages it, default 50). `complete` is false when
 * the page limit was hit before the end, so a caller never mistakes "not on the pages I read" for
 * "not in the organisation".
 */
export async function readStaffUsers(
  signal?: AbortSignal,
): Promise<{ items: StaffUser[]; complete: boolean }> {
  const items: StaffUser[] = [];
  for (let page = 1; page <= USERS_MAX_PAGES; page += 1) {
    const { data, error, response } = await api.GET('/v1/admin/users', {
      params: { query: { page, pageSize: USERS_PAGE_SIZE } },
      ...(signal ? { signal } : {}),
    });
    if (!data) fail(response, error);
    items.push(...data.items);
    const total = typeof data.total === 'number' ? data.total : null;
    if (data.items.length < USERS_PAGE_SIZE || (total !== null && items.length >= total)) {
      return { items, complete: true };
    }
  }
  return { items, complete: false };
}

type StaffUser = Schemas['StaffUser'];

export function useStaffUsers() {
  return useQuery({
    queryKey: adminKeys.users,
    queryFn: async ({ signal }) => (await readStaffUsers(signal)).items,
  });
}

/**
 * The fixed 500 on a staff invite (or re-issue) means the outcome is unknown (api-contract section
 * 8, FU-BE-208): the user row may exist and the mail may or may not have gone out. Reads the user
 * list (never sends again) and says whether the address is in it. 'unknown': the list could not be
 * read, or was too long to read in full.
 */
export async function checkInviteOutcome(
  qc: QueryClient,
  email: string,
): Promise<'found' | 'missing' | 'unknown'> {
  const startedIn = getGeneration();
  try {
    const { items, complete } = await readStaffUsers();
    // The session changed meanwhile: this answer is about someone else's organisation.
    if (startedIn !== getGeneration()) return 'unknown';
    qc.setQueryData(adminKeys.users, items);
    const wanted = email.trim().toLowerCase();
    if (items.some((u) => u.email.toLowerCase() === wanted)) return 'found';
    return complete ? 'missing' : 'unknown';
  } catch {
    return 'unknown';
  }
}
/** What to tell the user after the unknown-outcome 500 on an invite, given what the list says. */
export const INVITE_UNKNOWN_TEXT = {
  found:
    'The invitation may have been sent. The person is now in the list, so the account exists, but we could not confirm the email went out. Ask them to check their inbox before you send anything again.',
  missing:
    'We could not confirm the invitation. The person is not in the list yet, so it probably was not created. Check the list, then send it again if they are still missing.',
  unknown:
    'We could not confirm the invitation, and could not read the list to check. Reload the page and look for the person before you send it again.',
} as const;

/** Recent account lockouts, newest first (FR-101, P-03). The first page only: a short, recent list. */
export function useLockEvents(enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.lockEvents,
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET('/v1/admin/users/lock-events', {
        params: { query: { page: 1, pageSize: 20 } },
        signal,
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useOrgSettings() {
  return useQuery({
    queryKey: adminKeys.settings,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET('/v1/admin/settings', { signal });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['OrgSettingsPatch']) => {
      const { data, error, response } = await api.PATCH('/v1/admin/settings', { body });
      if (!data) fail(response, error);
      return data;
    },
    // Remember which session sent the save. If the user changed while it was in flight, its answer
    // belongs to someone else's org and must not be written into the new user's cache (FR-103).
    onMutate: () => getGeneration(),
    onSuccess: (data, _body, startedIn) => {
      if (startedIn === getGeneration()) qc.setQueryData(adminKeys.settings, data);
    },
  });
}

export function useConsentTexts() {
  return useQuery({
    queryKey: adminKeys.consent,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET('/v1/admin/consent-texts', { signal });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useCreateConsentText() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { version: string; bodyMd: string }) => {
      const { data, error, response } = await api.POST('/v1/admin/consent-texts', { body });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.consent }),
  });
}

export function useSetCurrentConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error, response } = await api.PUT(
        '/v1/admin/consent-texts/{consentTextId}/current',
        { params: { path: { consentTextId: id } } },
      );
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.consent }),
  });
}

export function useCandidates() {
  return useQuery({
    queryKey: adminKeys.candidates,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET('/v1/admin/candidates', { signal });
      if (!data) fail(response, error);
      return data.items;
    },
  });
}

export function useRequestErasure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (candidateId: string) => {
      const { data, error, response } = await api.POST(
        '/v1/admin/candidates/{candidateId}/erasure',
        { params: { path: { candidateId } } },
      );
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.candidates }),
  });
}
