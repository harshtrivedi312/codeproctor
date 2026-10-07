'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
};

export function useStaffUsers() {
  return useQuery({
    queryKey: adminKeys.users,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET('/v1/admin/users', { signal });
      if (!data) fail(response, error);
      return data.items;
    },
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: InviteBody) => {
      const { data, error, response } = await api.POST('/v1/admin/users', { body });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}
type InviteBody = { email: string; name: string; role: Schemas['StaffRole'] };

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; role?: Schemas['StaffRole']; active?: boolean }) => {
      const { id, ...body } = vars;
      const { data, error, response } = await api.PATCH('/v1/admin/users/{userId}', {
        params: { path: { userId: id } },
        body,
      });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
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
