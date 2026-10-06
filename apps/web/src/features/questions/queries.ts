'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import type { TestCase } from './draft';

/*
 * TanStack Query hooks for the question bank, against the real BE-04a routes (plus the web-only
 * placeholders listed in docs/followups/frontend.md). Question data (statements, hidden tests,
 * reference solutions, answer keys) lives only in this cache and in component state: never in a
 * URL, in storage or in a log. The cache is cleared when the signed-in user or role changes
 * (AuthProvider), and every write into it is dropped when the session changed since the request
 * started (generation guard). 401 handling and its retry are the shared client's (a 403 never
 * signs anyone out).
 */

export const questionKeys = {
  all: ['questions'] as const,
  list: (includeArchived: boolean) => ['questions', 'list', includeArchived] as const,
  detail: (id: string, version?: number) =>
    version === undefined
      ? (['questions', 'detail', id] as const)
      : (['questions', 'detail', id, version] as const),
  variants: (id: string, version: number) => ['questions', 'variants', id, version] as const,
  ai: (id: string) => ['questions', 'ai', id] as const,
};

/**
 * The question routes answer RFC 7807 problem bodies. 409 and 422 carry `detail` and `errors[]`
 * only (no machine code), so callers tell cases apart by endpoint and status, never by a code.
 */
function fail(response: Response, error: unknown): never {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const errors = Array.isArray(body.errors) ? body.errors.map((e) => text(e)).filter(Boolean) : [];
  throw new ApiFailure(response.status, text(body.detail) || text(body.message), '', errors);
}

export type QuestionSummary = Schemas['QuestionSummary'];
export type FullQuestion = Schemas['QuestionDetail'];
export type RedactedQuestion = Schemas['QuestionDetailRedacted'];
/** What a detail route returns: the full detail for writers, the allowlisted view for other readers. */
export type QuestionView = FullQuestion | RedactedQuestion;
/** Only the writer version carries a `revision`; the read view never does. */
export const isFullQuestion = (d: QuestionView): d is FullQuestion => 'revision' in d.version;

/** Status shown in the UI, derived from the summary (the API has no status field). */
export type QuestionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export function statusOf(s: Pick<QuestionSummary, 'isArchived' | 'latest'>): QuestionStatus {
  if (s.isArchived) return 'ARCHIVED';
  return s.latest.isPublished ? 'PUBLISHED' : 'DRAFT';
}

const MAX_LIST_PAGES = 20;

/** Every page of the list (the table filters and pages on the client). Writers also get archived ones. */
export function useQuestions(includeArchived: boolean) {
  return useQuery({
    queryKey: questionKeys.list(includeArchived),
    queryFn: async () => {
      const items: QuestionSummary[] = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const { data, error, response } = await api.GET('/v1/questions', {
          params: { query: { page, pageSize: 100, includeArchived } },
        });
        if (!data) fail(response, error);
        items.push(...data.items);
        if (items.length >= data.total || data.items.length === 0) break;
      }
      return items;
    },
  });
}

export async function fetchQuestion(id: string, version?: number): Promise<QuestionView> {
  const { data, error, response } = await api.GET('/v1/questions/{questionId}', {
    params: { path: { questionId: id }, ...(version !== undefined ? { query: { version } } : {}) },
  });
  if (!data) fail(response, error);
  return data;
}

export function useQuestion(id: string, version?: number) {
  return useQuery({
    queryKey: questionKeys.detail(id, version),
    // The editor owns its draft in form state; do not refetch over it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () => fetchQuestion(id, version),
  });
}

export async function fetchVariants(id: string, version: number): Promise<Schemas['Variant'][]> {
  const { data, error, response } = await api.GET('/v1/questions/{questionId}/variants', {
    params: { path: { questionId: id }, query: { version } },
  });
  if (!data) fail(response, error);
  return data.variants;
}

/** WEB-ONLY placeholder [BE-04b]: variants of one version, writers only. */
export function useVariants(id: string, version: number, enabled: boolean) {
  return useQuery({
    queryKey: questionKeys.variants(id, version),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () => fetchVariants(id, version),
  });
}

export function useCreateQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['CreateQuestion']) => {
      const { data, error, response } = await api.POST('/v1/questions', { body });
      if (!data) fail(response, error);
      return data;
    },
    // An answer that arrives after the user or the role changed must not be written into the
    // cache: it may hold the full view for someone who no longer may see it (FR-103).
    onMutate: () => getGeneration(),
    onSuccess: (data, _vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(questionKeys.detail(data.id), data);
      void qc.invalidateQueries({ queryKey: ['questions', 'list'] });
    },
  });
}

export interface SaveInput {
  /** The content fields of the PATCH (no test cases). */
  update: Omit<Schemas['UpdateQuestion'], 'expectedRevision'>;
  /** The revision the editor loaded; a concurrent change makes the PATCH a 409. */
  expectedRevision: string;
  /** The test cases as the form has them, in order. New rows carry a client-made id. */
  desiredCases: readonly TestCase[];
  /** The test cases the editor loaded (ids and order of the version being edited). */
  loadedCases: readonly { id: string; position: number }[];
  /** The variants as the form has them (null for a question without variants), web-only [BE-04b]. */
  variants: Schemas['Variant'][] | null;
  loadedVariants: Schemas['Variant'][];
  coding: boolean;
}

export interface SaveResult {
  detail: FullQuestion;
  variants: Schemas['Variant'][];
  createdNewVersion: boolean;
  /** Client-made test case id to the id the server gave it. */
  idMap: Record<string, string>;
}

/** The save stopped after part of it was written (the PATCH went through, a later call did not). */
export class PartialSaveFailure extends ApiFailure {
  constructor(
    inner: ApiFailure,
    readonly step: string,
  ) {
    super(inner.status, inner.message, inner.code, inner.errors);
  }
}

const sameCase = (a: Schemas['TestCase'], t: TestCase, position: number): boolean =>
  a.input === t.input &&
  a.expectedOutput === t.expectedOutput &&
  a.isHidden === t.isHidden &&
  a.weight === t.weight &&
  a.position === position;

/**
 * One save of the whole editor against the real routes: PATCH the content (which forks the next
 * draft when the latest version is published), then bring the test cases of THAT version in line
 * through the test-case routes (the PATCH takes no test cases), then (web-only) the variants, then
 * read the question back for the new revision. Each step checks the session is still the one that
 * started the save.
 */
export async function saveQuestion(id: string, input: SaveInput): Promise<SaveResult> {
  const startedIn = getGeneration();
  const stillSame = () => {
    if (getGeneration() !== startedIn) throw new ApiFailure(401, 'The session changed.');
  };
  const patched = await api.PATCH('/v1/questions/{questionId}', {
    params: { path: { questionId: id } },
    body: { ...input.update, expectedRevision: input.expectedRevision },
  });
  if (!patched.data) fail(patched.response, patched.error);
  const first = patched.data;
  const createdNewVersion = first.createdNewVersion;
  const idMap: Record<string, string> = {};
  let step = 'test cases';
  try {
    if (input.coding) {
      const server = [...first.version.testCases].sort((a, b) => a.position - b.position);
      // A forked draft has copies of the cases with new ids, in the same order.
      const loaded = [...input.loadedCases].sort((a, b) => a.position - b.position);
      const serverIdOf = new Map<string, string>();
      loaded.forEach((l, i) => {
        const copy = server[i];
        if (copy) serverIdOf.set(l.id, createdNewVersion ? copy.id : l.id);
      });
      const wanted = input.desiredCases.map((t) => ({ t, serverId: serverIdOf.get(t.id) ?? null }));
      const keep = new Set(wanted.flatMap((w) => (w.serverId ? [w.serverId] : [])));
      const base = {
        params: { path: { questionId: id, version: first.version.version } },
      } as const;
      for (const s of server) {
        if (keep.has(s.id)) continue;
        stillSame();
        const r = await api.DELETE(
          '/v1/questions/{questionId}/versions/{version}/test-cases/{testCaseId}',
          {
            params: { path: { ...base.params.path, testCaseId: s.id } },
          },
        );
        if (!r.response.ok) fail(r.response, r.error);
      }
      for (const [position, w] of wanted.entries()) {
        stillSame();
        const current = server.find((s) => s.id === w.serverId);
        if (current && w.serverId) {
          idMap[w.t.id] = w.serverId;
          if (sameCase(current, w.t, position)) continue;
          const r = await api.PATCH(
            '/v1/questions/{questionId}/versions/{version}/test-cases/{testCaseId}',
            {
              params: { path: { ...base.params.path, testCaseId: w.serverId } },
              body: {
                input: w.t.input,
                expectedOutput: w.t.expectedOutput,
                isHidden: w.t.isHidden,
                weight: w.t.weight,
                position,
              },
            },
          );
          if (!r.data) fail(r.response, r.error);
        } else {
          const r = await api.POST('/v1/questions/{questionId}/versions/{version}/test-cases', {
            params: base.params,
            body: {
              input: w.t.input,
              expectedOutput: w.t.expectedOutput,
              isHidden: w.t.isHidden,
              weight: w.t.weight,
              position,
            },
          });
          if (!r.data) fail(r.response, r.error);
          idMap[w.t.id] = r.data.id;
        }
      }
      if (input.variants !== null) {
        step = 'variants';
        const mapped = input.variants.map((v) => ({
          ...v,
          overrides: v.overrides.flatMap((o) => {
            const id2 = idMap[o.testCaseId];
            return id2 ? [{ ...o, testCaseId: id2 }] : [];
          }),
        }));
        const loadedMapped = input.loadedVariants.map((v) => ({
          ...v,
          overrides: v.overrides.map((o) => ({
            ...o,
            testCaseId: idMap[o.testCaseId] ?? o.testCaseId,
          })),
        }));
        if (createdNewVersion || JSON.stringify(mapped) !== JSON.stringify(loadedMapped)) {
          stillSame();
          const r = await api.PUT('/v1/questions/{questionId}/variants', {
            params: { path: { questionId: id } },
            body: { variants: mapped },
          });
          if (!r.data) fail(r.response, r.error);
        }
      }
    }
    stillSame();
    const back = await fetchQuestion(id);
    if (!isFullQuestion(back)) throw new ApiFailure(403, 'Your role cannot edit this question.');
    const variants = input.coding ? await fetchVariants(id, back.version.version) : [];
    return { detail: back, variants, createdNewVersion, idMap };
  } catch (e) {
    if (e instanceof ApiFailure) throw new PartialSaveFailure(e, step);
    throw e;
  }
}

export function useSaveQuestion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput) => saveQuestion(id, input),
    onMutate: () => getGeneration(),
    onSuccess: (result, _vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(questionKeys.detail(id), result.detail);
      qc.setQueryData(questionKeys.variants(id, result.detail.version.version), result.variants);
      void qc.invalidateQueries({ queryKey: ['questions', 'list'] });
    },
  });
}

export function useStartValidation(id: string) {
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/validate', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

/** One poll of a validation job. The editor loops over this until the job is done or failed. */
export async function fetchValidationJob(
  id: string,
  jobId: string,
): Promise<Schemas['ValidationJob']> {
  const { data, error, response } = await api.GET('/v1/questions/{questionId}/validation/{jobId}', {
    params: { path: { questionId: id, jobId } },
  });
  if (!data) fail(response, error);
  return data;
}

export function usePublishQuestion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (expectedRevision: string) => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/publish', {
        params: { path: { questionId: id } },
        body: { expectedRevision },
      });
      if (!data) fail(response, error);
      return data;
    },
    onMutate: () => getGeneration(),
    onSuccess: (data, _vars, startedIn) => {
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(questionKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: ['questions', 'list'] });
    },
  });
}

export function usePrefill(id: string) {
  return useMutation({
    mutationFn: async (body: Schemas['PrefillRequest']) => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/prefill', {
        params: { path: { questionId: id } },
        body,
      });
      if (!data) fail(response, error);
      return data.proposals;
    },
  });
}

export function useAiReferences(id: string) {
  return useQuery({
    queryKey: questionKeys.ai(id),
    // No question yet (create mode, or a type without AI solutions): no request.
    enabled: id !== '',
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions/{questionId}/ai-references', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useAddAiReference(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { body: Schemas['AiReferenceInput']; supersedes?: string }) => {
      const result = vars.supersedes
        ? await api.POST('/v1/questions/{questionId}/ai-references/{referenceId}/supersede', {
            params: { path: { questionId: id, referenceId: vars.supersedes } },
            body: vars.body,
          })
        : await api.POST('/v1/questions/{questionId}/ai-references', {
            params: { path: { questionId: id } },
            body: vars.body,
          });
      if (!result.data) fail(result.response, result.error);
      return result.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: questionKeys.ai(id) }),
  });
}
