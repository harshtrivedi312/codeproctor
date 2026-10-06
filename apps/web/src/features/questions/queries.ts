'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { api, type Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import type { DesiredVariant, TestCase } from './draft';

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
  /** The content fields of the PATCH (no test cases, no variants). */
  update: Omit<Schemas['UpdateQuestion'], 'expectedRevision'>;
  /** The revision the editor loaded; a concurrent change makes the first write a 409. */
  expectedRevision: string;
  /** The test cases as the form has them, in order. New rows carry a client-made id. */
  desiredCases: readonly TestCase[];
  /** The variants as the form has them (null for a question that has none). New ones carry a client-made id. */
  variants: DesiredVariant[] | null;
  /** The version the editor loaded (test cases and variants of the version being edited). */
  loaded: Schemas['QuestionVersion'];
  coding: boolean;
}

export interface SaveResult {
  detail: FullQuestion;
  createdNewVersion: boolean;
  /** Client-made test case id to the id the server gave it. */
  idMap: Record<string, string>;
}

/** The save stopped after part of it was written (an earlier call went through, a later one did not). */
export type SaveStep = 'variants' | 'test cases' | 'reload';
export class PartialSaveFailure extends ApiFailure {
  constructor(
    inner: ApiFailure,
    readonly step: SaveStep,
  ) {
    super(inner.status, inner.message, inner.code, inner.errors);
  }
}

type ServerCase = Schemas['TestCase'];
type ServerVariant = Schemas['Variant'];
type ParamsOf = Record<string, string | number | boolean>;

const caseKey = (
  t:
    | ServerCase
    | {
        position: number;
        input?: string;
        expectedOutput?: string;
        isHidden: boolean;
        weight: number;
      },
) => JSON.stringify([t.position, t.input ?? '', t.expectedOutput ?? '', t.isHidden, t.weight]);

/**
 * Pairs the items the editor loaded with the copies a fork made, by content and then by order. A
 * fork copies test cases and variants with NEW ids, so ids cannot be used; two identical items pair
 * in order. Items without a partner are left out.
 */
function pairByKey<A, B>(
  from: readonly A[],
  to: readonly B[],
  keyA: (a: A) => string,
  keyB: (b: B) => string,
): Map<A, B> {
  const pool = new Map<string, B[]>();
  for (const b of to) pool.set(keyB(b), [...(pool.get(keyB(b)) ?? []), b]);
  const out = new Map<A, B>();
  for (const a of from) {
    const next = pool.get(keyA(a))?.shift();
    if (next !== undefined) out.set(a, next);
  }
  return out;
}

const sameParams = (a: ParamsOf, b: ParamsOf): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const sameCase = (a: ServerCase, t: TestCase, position: number): boolean =>
  a.input === t.input &&
  a.expectedOutput === t.expectedOutput &&
  a.isHidden === t.isHidden &&
  a.weight === t.weight &&
  a.position === position;

/**
 * One save of the whole editor against the real routes (BE-04a/b). Order: (1) for a DRAFT that
 * already has variants, a variant whose params gain a name is first given the union of old and new
 * params, so the statement PATCH below still renders for every active variant (the API refuses a
 * PATCH that leaves an active variant with an unknown placeholder); (2) PATCH the content, which
 * forks the next draft when the latest version is published (the server copies test cases and
 * variants with new ids and re-points overrides); (3) test cases through their own routes; (4)
 * variants and their per-slot overrides through the variant routes; (5) read the question back for
 * the new revision. A step that fails after something was written is a PartialSaveFailure naming the
 * step. Each step checks the session is still the one that started the save.
 */
export async function saveQuestion(id: string, input: SaveInput): Promise<SaveResult> {
  const startedIn = getGeneration();
  const stillSame = () => {
    if (getGeneration() !== startedIn) throw new ApiFailure(401, 'The session changed.');
  };
  let step: SaveStep = 'variants';
  let wrote = false;
  const loaded = input.loaded;
  const desired = input.variants;
  // The revision the next write expects; each variant write returns the new one.
  let expectedRevision = input.expectedRevision;
  try {
    // (1) Additive param updates on a draft.
    if (input.coding && desired !== null && !loaded.isPublished) {
      for (const d of desired) {
        const old = loaded.variants.find((x) => x.id === d.id);
        if (!old) continue;
        const union: ParamsOf = { ...old.params, ...d.params };
        if (sameParams(union, old.params)) continue;
        stillSame();
        const r = await api.PATCH(
          '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
          {
            params: { path: { questionId: id, version: loaded.version, variantId: old.id } },
            body: { params: union, expectedRevision },
          },
        );
        if (!r.data) fail(r.response, r.error);
        expectedRevision = r.data.revision;
        wrote = true;
      }
    }
    // (2) The content.
    step = 'variants';
    stillSame();
    const patched = await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: id } },
      body: { ...input.update, expectedRevision },
    });
    if (!patched.data) fail(patched.response, patched.error);
    const first = patched.data;
    wrote = true;
    const createdNewVersion = first.createdNewVersion;
    const idMap: Record<string, string> = {};
    if (input.coding) {
      const version = first.version.version;
      const server = [...first.version.testCases].sort((a, b) => a.position - b.position);
      // On a fork every case is a copy with a new id: find each loaded case's copy by content.
      const copyOf = createdNewVersion
        ? pairByKey(loaded.testCases, server, caseKey, caseKey)
        : null;
      const serverIdOf = (loadedId: string): string | null => {
        const l = loaded.testCases.find((c) => c.id === loadedId);
        if (!l) return null;
        return copyOf ? (copyOf.get(l)?.id ?? null) : l.id;
      };
      // (3) Test cases.
      step = 'test cases';
      const wanted = input.desiredCases.map((t) => ({ t, serverId: serverIdOf(t.id) }));
      const keep = new Set(wanted.flatMap((w) => (w.serverId ? [w.serverId] : [])));
      const path = { questionId: id, version };
      for (const s of server) {
        if (keep.has(s.id)) continue;
        stillSame();
        const r = await api.DELETE(
          '/v1/questions/{questionId}/versions/{version}/test-cases/{testCaseId}',
          { params: { path: { ...path, testCaseId: s.id } } },
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
              params: { path: { ...path, testCaseId: w.serverId } },
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
            params: { path },
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
      // (4) Variants and overrides.
      step = 'variants';
      if (desired !== null) {
        const slotPosition = (cases: readonly ServerCase[]) =>
          new Map(cases.map((c) => [c.id, c.position]));
        const loadedPos = slotPosition(loaded.testCases);
        const variantKey = (x: ServerVariant, pos: Map<string, number>) =>
          JSON.stringify([
            Object.entries(x.params).sort(),
            x.isActive,
            x.testCaseOverrides
              .map((o) => [pos.get(o.testCaseId) ?? -1, o.input, o.expectedOutput])
              .sort(),
          ]);
        const copyV = createdNewVersion
          ? pairByKey(
              loaded.variants,
              first.version.variants,
              (x) => variantKey(x, loadedPos),
              (x) => variantKey(x, slotPosition(first.version.testCases)),
            )
          : null;
        const serverVariantOf = (formId: string): ServerVariant | undefined => {
          const l = loaded.variants.find((x) => x.id === formId);
          if (!l) return undefined;
          return copyV
            ? copyV.get(l)
            : (first.version.variants.find((x) => x.id === l.id) ?? undefined);
        };
        const matched = new Set<string>();
        for (const d of desired) {
          const sv = serverVariantOf(d.id);
          if (sv) matched.add(sv.id);
        }
        const vpath = { questionId: id, version };
        for (const sv of first.version.variants) {
          if (matched.has(sv.id)) continue;
          stillSame();
          const r = await api.DELETE(
            '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
            { params: { path: { ...vpath, variantId: sv.id } } },
          );
          if (!r.response.ok) fail(r.response, r.error);
        }
        for (const d of desired) {
          stillSame();
          let sv = serverVariantOf(d.id);
          let existing = sv ? sv.testCaseOverrides : [];
          if (!sv) {
            const r = await api.POST('/v1/questions/{questionId}/versions/{version}/variants', {
              params: { path: vpath },
              body: { params: d.params, isActive: d.isActive },
            });
            if (!r.data) fail(r.response, r.error);
            sv = r.data.variant;
            existing = [];
          } else if (!sameParams(d.params, sv.params) || d.isActive !== sv.isActive) {
            const r = await api.PATCH(
              '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
              {
                params: { path: { ...vpath, variantId: sv.id } },
                body: { params: d.params, isActive: d.isActive },
              },
            );
            if (!r.data) fail(r.response, r.error);
          }
          const variantId = sv.id;
          // Overrides: the form's slot ids map to the server's; a slot that was removed took its overrides along.
          const wantedOverrides = d.overrides.flatMap((o) => {
            const slot = idMap[o.testCaseId];
            return slot ? [{ slot, input: o.input, expectedOutput: o.expectedOutput }] : [];
          });
          const live = existing.filter((o) => keep.has(o.testCaseId));
          for (const o of live) {
            if (wantedOverrides.some((w) => w.slot === o.testCaseId)) continue;
            stillSame();
            const r = await api.DELETE(
              '/v1/questions/{questionId}/versions/{version}/variants/{variantId}/test-cases/{testCaseId}',
              { params: { path: { ...vpath, variantId, testCaseId: o.testCaseId } } },
            );
            if (!r.response.ok) fail(r.response, r.error);
          }
          for (const w of wantedOverrides) {
            const have = live.find((o) => o.testCaseId === w.slot);
            if (have && have.input === w.input && have.expectedOutput === w.expectedOutput)
              continue;
            stillSame();
            const r = await api.PUT(
              '/v1/questions/{questionId}/versions/{version}/variants/{variantId}/test-cases/{testCaseId}',
              {
                params: { path: { ...vpath, variantId, testCaseId: w.slot } },
                body: { input: w.input, expectedOutput: w.expectedOutput },
              },
            );
            if (!r.data) fail(r.response, r.error);
          }
        }
      }
    }
    // (5) Read it back: the new revision and the server's own ids.
    step = 'reload';
    stillSame();
    const back = await fetchQuestion(id);
    if (!isFullQuestion(back)) throw new ApiFailure(403, 'Your role cannot edit this question.');
    return { detail: back, createdNewVersion, idMap };
  } catch (e) {
    // Nothing was written before the first PATCH: that failure is the plain one (409 stays a 409).
    if (e instanceof ApiFailure && wrote) throw new PartialSaveFailure(e, step);
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
      // Versioned copies of this question (older versions, a view opened earlier) are out of date now.
      void qc.invalidateQueries({ queryKey: ['questions', 'detail', id], refetchType: 'none' });
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
      void qc.invalidateQueries({ queryKey: ['questions', 'detail', id], refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: ['questions', 'list'] });
    },
  });
}

/** The candidate-shaped view of one SAVED variant (question:read; no params, hidden data or key). */
export function usePreviewVariant(id: string, version: number) {
  return useMutation({
    mutationFn: async (variantId: string) => {
      const { data, error, response } = await api.GET(
        '/v1/questions/{questionId}/versions/{version}/variants/{variantId}/preview',
        { params: { path: { questionId: id, version, variantId } } },
      );
      if (!data) fail(response, error);
      return data;
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
