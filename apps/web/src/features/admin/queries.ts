'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';

/** An API answer that was not 2xx, carrying the status so screens can explain it. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's machine code (for example `validation_required`), when it sent one. */
    readonly code: string = '',
  ) {
    super(message);
  }
}

function fail(response: Response, error: unknown): never {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  throw new ApiFailure(response.status, message);
}

export const adminKeys = {
  users: ['admin', 'users'] as const,
  settings: ['admin', 'settings'] as const,
  consent: ['admin', 'consent-texts'] as const,
  candidates: ['admin', 'candidates'] as const,
};

export function useStaffUsers() {
  return useQuery({
    queryKey: adminKeys.users,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/admin/users');
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
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/admin/settings');
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
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/admin/consent-texts');
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
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/admin/candidates');
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
