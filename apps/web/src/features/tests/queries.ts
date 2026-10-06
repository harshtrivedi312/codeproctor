'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import { detailSignature } from './draft';

/*
 * Hooks for the tests module (FR-301, FR-302) on the REAL BE-06a routes. The cache is cleared on a
 * user or role change (AuthProvider) and every write into it is dropped when the session changed
 * since the request started. Test content (names, question picks) lives in the cache and in the
 * form only.
 */

export const testKeys = {
  all: ['tests'] as const,
  list: ['tests', 'list'] as const,
  detail: (id: string) => ['tests', 'detail', id] as const,
};

export type TestSummary = Schemas['TestSummary'];
export type TestDetail = Schemas['TestDetail'];

function fail(response: Response, error: unknown): never {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const errors = Array.isArray(body.errors) ? body.errors.map((e) => text(e)).filter(Boolean) : [];
  throw new ApiFailure(response.status, text(body.detail) || text(body.message), '', errors);
}

const MAX_PAGES = 20;

/** Every page of the list (the table filters and pages on the client). */
export function useTests() {
  return useQuery({
    queryKey: testKeys.list,
    queryFn: async () => {
      const items: TestSummary[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data, error, response } = await api.GET('/v1/tests', {
          params: { query: { page, pageSize: 100 } },
        });
        if (!data) fail(response, error);
        items.push(...data.items);
        if (items.length >= data.total || data.items.length === 0) break;
      }
      return items;
    },
  });
}

export async function fetchTest(id: string): Promise<TestDetail> {
  const { data, error, response } = await api.GET('/v1/tests/{testId}', {
    params: { path: { testId: id } },
  });
  if (!data) fail(response, error);
  return data;
}

export function useTest(id: string | null) {
  return useQuery({
    queryKey: testKeys.detail(id ?? ''),
    enabled: id !== null,
    // The builder owns its draft in form state: never refetch over it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () => fetchTest(id ?? ''),
  });
}

export function useCreateTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['CreateTest']) => {
      const { data, error, response } = await api.POST('/v1/tests', { body });
      if (!data) fail(response, error);
      return data;
    },
    onMutate: () => getGeneration(),
    onSuccess: (data, _vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(testKeys.detail(data.id), data);
      void qc.invalidateQueries({ queryKey: testKeys.list });
    },
  });
}

/** The edit found the test changed (or used) by someone else since it was loaded. */
export class TestChangedFailure extends ApiFailure {
  constructor(readonly reason: 'changed' | 'used') {
    super(409, reason === 'used' ? 'The test already has invitations.' : 'The test changed.');
  }
}

/**
 * Saves an edit. The API has NO revision or If-Match on PATCH (two editors are last-write-wins),
 * so the web narrows the window: it reads the test again right before the PATCH and refuses to
 * write over a test that is no longer what the form was loaded from. A change between that read
 * and the PATCH can still be overwritten: a gap only the API can close (a revision on the test).
 */
export async function saveTest(
  id: string,
  loaded: TestDetail,
  body: Schemas['UpdateTest'],
): Promise<TestDetail> {
  const startedIn = getGeneration();
  const current = await fetchTest(id);
  if (startedIn !== getGeneration()) throw new ApiFailure(401, 'The session changed.');
  if (current.used) throw new TestChangedFailure('used');
  if (detailSignature(current) !== detailSignature(loaded)) throw new TestChangedFailure('changed');
  const { data, error, response } = await api.PATCH('/v1/tests/{testId}', {
    params: { path: { testId: id } },
    body,
  });
  if (!data) fail(response, error);
  return data;
}

export function useSaveTest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { loaded: TestDetail; body: Schemas['UpdateTest'] }) =>
      saveTest(id, vars.loaded, vars.body),
    onMutate: () => getGeneration(),
    onSuccess: (data, _vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(testKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: testKeys.list });
    },
  });
}
