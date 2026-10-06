'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure } from '@/features/admin/queries';
import { api, type Schemas } from '@/lib/api/client';
import { useAuth } from '@/features/auth/auth-provider';
import { can } from '@/features/staff/permissions';
import { getGeneration } from '@/lib/auth-session';
import type { DesiredVariant, TestCase } from './draft';

/*
 * TanStack Query hooks for the question bank, against the real BE-04a/b/c routes (only prefill is
 * a web-only placeholder, see docs/followups/frontend.md). Question data (statements, hidden tests,
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
  ai: (id: string, version: number) => ['questions', 'ai', id, version] as const,
  aiPolicy: (userId: string) => ['questions', 'ai-policy', userId] as const,
};

/** The one machine code the question routes set: deleting a variant that has AI rows (409). */
export const VARIANT_HAS_AI_REFERENCES = 'VARIANT_HAS_AI_REFERENCES';
export const isVariantHasAiRefs = (e: unknown): boolean =>
  e instanceof ApiFailure && e.status === 409 && e.code === VARIANT_HAS_AI_REFERENCES;

/**
 * The question routes answer RFC 7807 problem bodies. 409 and 422 carry `detail` and `errors[]`;
 * callers tell cases apart by endpoint and status, and by `code` only for VARIANT_HAS_AI_REFERENCES.
 * Any other `code` is ignored here (the question routes define no other).
 */
function fail(response: Response, error: unknown): never {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const errors = Array.isArray(body.errors) ? body.errors.map((e) => text(e)).filter(Boolean) : [];
  const code = body.code === VARIANT_HAS_AI_REFERENCES ? VARIANT_HAS_AI_REFERENCES : '';
  throw new ApiFailure(response.status, text(body.detail) || text(body.message), code, errors);
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

/** Where a save stopped: before the content PATCH (variants), the PATCH, test cases, variants, or the read-back. */
export type SaveStep = 'variants' | 'content' | 'test cases' | 'reload';

/** The delete of a variant was refused because it has AI rows: which variant, so the form can put it back. */
export class VariantBlockedFailure extends ApiFailure {
  constructor(
    inner: ApiFailure,
    readonly variantId: string,
  ) {
    super(inner.status, inner.message, inner.code, inner.errors);
  }
}

/** The save stopped after part of it was written (an earlier call went through, a later one did not). */
export class PartialSaveFailure extends ApiFailure {
  /** The variant whose delete was refused (VARIANT_HAS_AI_REFERENCES), when that is what happened. */
  readonly blockedVariantId: string | null;
  constructor(
    inner: ApiFailure,
    readonly step: SaveStep,
    /** The content PATCH forked a new draft: ids in the form no longer match the server's. */
    readonly forked: boolean,
    /**
     * The revision known to match the server after the last CONFIRMED write: null when a write that
     * answers no revision went through but could not be confirmed (its read-back failed or showed
     * something we did not write). Only fresh data with exactly this revision may be adopted.
     */
    readonly lastRevision: string | null,
    /** The session generation the save started in. */
    readonly generation: number,
  ) {
    super(inner.status, inner.message, inner.code, inner.errors);
    this.blockedVariantId = inner instanceof VariantBlockedFailure ? inner.variantId : null;
  }
}

type ServerCase = Schemas['TestCase'];
type ServerVariant = Schemas['Variant'];
type ServerVersion = Schemas['QuestionVersion'];
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
 * The part of a version other editors can change under a save: its test cases and variants with
 * their overrides. Without `ids` the slots are named by position, so a fork copy (new ids) can be
 * compared with its source.
 */
export function slotsSignature(v: ServerVersion, ids = true): string {
  const pos = new Map(v.testCases.map((t) => [t.id, t.position]));
  const cases = v.testCases
    .map((t) => [
      ids ? t.id : '',
      t.position,
      t.isHidden,
      t.weight,
      t.input ?? '',
      t.expectedOutput ?? '',
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const variants = v.variants
    .map((x) => [
      ids ? x.id : '',
      x.isActive,
      Object.entries(x.params).sort(),
      x.testCaseOverrides
        .map((o) => [ids ? o.testCaseId : (pos.get(o.testCaseId) ?? -1), o.input, o.expectedOutput])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([cases, variants]);
}

/** The expected state after one of our own writes, built from the last confirmed one. */
const upsertCase = (v: ServerVersion, c: ServerCase): ServerVersion => ({
  ...v,
  testCases: [...v.testCases.filter((t) => t.id !== c.id), c],
});
const dropCase = (v: ServerVersion, id: string): ServerVersion => ({
  ...v,
  testCases: v.testCases.filter((t) => t.id !== id),
  variants: v.variants.map((x) => ({
    ...x,
    testCaseOverrides: x.testCaseOverrides.filter((o) => o.testCaseId !== id),
  })),
});
const upsertVariant = (v: ServerVersion, x: ServerVariant): ServerVersion => ({
  ...v,
  variants: [...v.variants.filter((y) => y.id !== x.id), x],
});
const dropVariant = (v: ServerVersion, id: string): ServerVersion => ({
  ...v,
  variants: v.variants.filter((y) => y.id !== id),
});
const withOverride = (
  v: ServerVersion,
  variantId: string,
  o: ServerVariant['testCaseOverrides'][number],
): ServerVersion => ({
  ...v,
  variants: v.variants.map((x) =>
    x.id === variantId
      ? {
          ...x,
          testCaseOverrides: [
            ...x.testCaseOverrides.filter((y) => y.testCaseId !== o.testCaseId),
            o,
          ],
        }
      : x,
  ),
});
const withoutOverride = (
  v: ServerVersion,
  variantId: string,
  testCaseId: string,
): ServerVersion => ({
  ...v,
  variants: v.variants.map((x) =>
    x.id === variantId
      ? { ...x, testCaseOverrides: x.testCaseOverrides.filter((y) => y.testCaseId !== testCaseId) }
      : x,
  ),
});

/**
 * One save of the whole editor against the real routes (BE-04a/b). Every write after the first
 * carries `expectedRevision`, chained, and the chain only ever holds a revision that is CONFIRMED
 * to be the state our own write produced:
 *  - the content PATCH, variant create/patch answer a revision, but the PATCH's answer is read after
 *    its transaction, so its test cases and variants are compared with what we expect;
 *  - a write that answers NO revision (test cases, overrides, variant delete) is followed by a read
 *    of the whole version, which must equal the last confirmed state plus exactly that write. If it
 *    does not (another editor committed in between) the save stops as a 409 and nothing further is
 *    written: another editor's change is never adopted as our base.
 * Costs one full read per such write (the API answers no revision there: a question for Backend A).
 * Order: (1) for a DRAFT with variants, a variant whose params gain a name first gets the union of
 * old and new params (so the statement PATCH still renders for every active variant), and variants
 * the form removed are deleted (so a variant lacking a newly added placeholder cannot make the PATCH
 * a 400); (2) PATCH the content, which forks the next draft when the latest version is published
 * (the server copies test cases and variants with new ids and re-points overrides); (3) test cases;
 * (4) variants and per-slot overrides; (5) read the question back. A step that fails after
 * something was written is a PartialSaveFailure naming the step. Each step checks the session is
 * still the one that started the save.
 */
export async function saveQuestion(id: string, input: SaveInput): Promise<SaveResult> {
  const startedIn = getGeneration();
  const stillSame = () => {
    if (getGeneration() !== startedIn) throw new ApiFailure(401, 'The session changed.');
  };
  let step: SaveStep = 'variants';
  let wrote = false;
  let forked = false;
  const loaded = input.loaded;
  const desired = input.variants;
  let rev = input.expectedRevision;
  /** The last revision CONFIRMED to match the server (null while a write is unconfirmed). */
  let confirmed: string | null = input.expectedRevision;
  /** The last confirmed full state of the version being written. */
  let known: ServerVersion = loaded;

  /** After a write that answered a revision: the answer is exact, take it with the state we expect. */
  const accept = (expected: ServerVersion, revision: string): void => {
    known = expected;
    rev = revision;
    confirmed = revision;
  };
  /** After a write that answered none: read the version back and require exactly the expected state. */
  const confirm = async (expected: ServerVersion): Promise<void> => {
    confirmed = null;
    const back = await fetchQuestion(id);
    if (!isFullQuestion(back)) throw new ApiFailure(403, 'Your role cannot edit this question.');
    if (
      back.version.version !== expected.version ||
      slotsSignature(back.version) !== slotsSignature(expected)
    ) {
      throw new ApiFailure(
        409,
        'Someone else changed this question while your changes were being saved.',
      );
    }
    accept(back.version, back.version.revision);
  };

  try {
    const draftWithVariants = input.coding && desired !== null && !loaded.isPublished;
    if (draftWithVariants) {
      const lpath = { questionId: id, version: loaded.version };
      // (1a) Additive param updates and switching variants off.
      for (const d of desired) {
        const old = loaded.variants.find((x) => x.id === d.id);
        if (!old) continue;
        const union: ParamsOf = { ...old.params, ...d.params };
        // A variant that is being switched off goes inactive first too: an inactive variant is not
        // rendered, so it cannot make the statement PATCH a 400.
        const deactivate = old.isActive && !d.isActive;
        const paramsChange = !sameParams(union, old.params);
        if (!paramsChange && !deactivate) continue;
        stillSame();
        const r = await api.PATCH(
          '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
          {
            params: { path: { ...lpath, variantId: old.id } },
            body: {
              ...(paramsChange ? { params: union } : {}),
              ...(deactivate ? { isActive: false } : {}),
              expectedRevision: rev,
            },
          },
        );
        if (!r.data) fail(r.response, r.error);
        wrote = true;
        accept(upsertVariant(known, r.data.variant), r.data.revision);
      }
      // (1b) Removed variants go before the content PATCH.
      const keepIds = new Set(desired.map((d) => d.id));
      for (const old of loaded.variants) {
        if (keepIds.has(old.id)) continue;
        blockDone: {
          stillSame();
          const r = await api.DELETE(
            '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
            {
              params: {
                path: { ...lpath, variantId: old.id },
                query: { expectedRevision: rev },
              },
            },
          );
          if (!r.response.ok) {
            try {
              fail(r.response, r.error);
            } catch (e) {
              throw isVariantHasAiRefs(e) ? new VariantBlockedFailure(e as ApiFailure, old.id) : e;
            }
          }
          wrote = true;
          await confirm(dropVariant(known, old.id));
          break blockDone;
        }
      }
    }
    // (2) The content.
    step = 'content';
    stillSame();
    const patched = await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: id } },
      body: { ...input.update, expectedRevision: rev },
    });
    if (!patched.data) fail(patched.response, patched.error);
    const first = patched.data;
    wrote = true;
    const createdNewVersion = first.createdNewVersion;
    forked = createdNewVersion;
    // The PATCH answers a revision, but its answer is read after its transaction: its test cases and
    // variants must be what they were (a fork: copies of them), or another editor wrote in between.
    confirmed = null;
    if (
      slotsSignature(first.version, !createdNewVersion) !==
      slotsSignature(known, !createdNewVersion)
    ) {
      throw new ApiFailure(
        409,
        'Someone else changed this question while your changes were being saved.',
      );
    }
    accept(first.version, first.version.revision);
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
      for (const sc of server) {
        if (keep.has(sc.id)) continue;
        stillSame();
        const r = await api.DELETE(
          '/v1/questions/{questionId}/versions/{version}/test-cases/{testCaseId}',
          {
            params: {
              path: { ...path, testCaseId: sc.id },
              query: { expectedRevision: rev },
            },
          },
        );
        if (!r.response.ok) fail(r.response, r.error);
        await confirm(dropCase(known, sc.id));
      }
      for (const [position, w] of wanted.entries()) {
        rowDone: {
          stillSame();
          const current = server.find((sc) => sc.id === w.serverId);
          if (current && w.serverId) {
            idMap[w.t.id] = w.serverId;
            if (sameCase(current, w.t, position)) break rowDone;
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
                  expectedRevision: rev,
                },
              },
            );
            if (!r.data) fail(r.response, r.error);
            await confirm(upsertCase(known, r.data));
          } else {
            const r = await api.POST('/v1/questions/{questionId}/versions/{version}/test-cases', {
              params: { path },
              body: {
                input: w.t.input,
                expectedOutput: w.t.expectedOutput,
                isHidden: w.t.isHidden,
                weight: w.t.weight,
                position,
                expectedRevision: rev,
              },
            });
            if (!r.data) fail(r.response, r.error);
            idMap[w.t.id] = r.data.id;
            await confirm(upsertCase(known, r.data));
          }
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
        // Only a fork still has removed variants to delete here (a draft's went in step 1).
        for (const sv of first.version.variants) {
          if (matched.has(sv.id)) continue;
          stillSame();
          const r = await api.DELETE(
            '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
            {
              params: {
                path: { ...vpath, variantId: sv.id },
                query: { expectedRevision: rev },
              },
            },
          );
          if (!r.response.ok) {
            try {
              fail(r.response, r.error);
            } catch (e) {
              throw isVariantHasAiRefs(e) ? new VariantBlockedFailure(e as ApiFailure, sv.id) : e;
            }
          }
          await confirm(dropVariant(known, sv.id));
        }
        for (const d of desired) {
          stillSame();
          let sv = serverVariantOf(d.id);
          let existing = sv ? sv.testCaseOverrides : [];
          if (!sv) {
            const r = await api.POST('/v1/questions/{questionId}/versions/{version}/variants', {
              params: { path: vpath },
              body: { params: d.params, isActive: d.isActive, expectedRevision: rev },
            });
            if (!r.data) fail(r.response, r.error);
            sv = r.data.variant;
            accept(upsertVariant(known, sv), r.data.revision);
            existing = [];
          } else if (!sameParams(d.params, sv.params) || d.isActive !== sv.isActive) {
            const r = await api.PATCH(
              '/v1/questions/{questionId}/versions/{version}/variants/{variantId}',
              {
                params: { path: { ...vpath, variantId: sv.id } },
                body: { params: d.params, isActive: d.isActive, expectedRevision: rev },
              },
            );
            if (!r.data) fail(r.response, r.error);
            sv = r.data.variant;
            accept(upsertVariant(known, sv), r.data.revision);
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
              {
                params: {
                  path: { ...vpath, variantId, testCaseId: o.testCaseId },
                  query: { expectedRevision: rev },
                },
              },
            );
            if (!r.response.ok) fail(r.response, r.error);
            await confirm(withoutOverride(known, variantId, o.testCaseId));
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
                body: { input: w.input, expectedOutput: w.expectedOutput, expectedRevision: rev },
              },
            );
            if (!r.data) fail(r.response, r.error);
            await confirm(withOverride(known, variantId, r.data));
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
    // Nothing was written before the first failure: that failure is the plain one (409 stays a 409).
    if (!wrote) throw e;
    // Part of it is on the server. A network error (not an ApiFailure) says so too, with status 0.
    const inner = e instanceof ApiFailure ? e : new ApiFailure(0, '');
    throw new PartialSaveFailure(inner, step, forked, confirmed, startedIn);
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

/** Start a validation run of the saved draft; it is bound to the revision the editor loaded. */
export function useStartValidation(id: string) {
  return useMutation({
    mutationFn: async (expectedRevision: string) => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/validate', {
        params: { path: { questionId: id } },
        body: { expectedRevision },
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export type ValidationState = Schemas['ValidationStatus'];
export type ValidationReport = Schemas['ValidationReport'];

/** One read of the validation status of the question (there is one run per question, no job id). */
export async function fetchValidation(id: string): Promise<ValidationState> {
  const { data, error, response } = await api.GET('/v1/questions/{questionId}/validation', {
    params: { path: { questionId: id } },
  });
  if (!data) fail(response, error);
  return data;
}

/** The status carries the report as an open object; only a well-formed one is used. */
export function asReport(value: unknown): ValidationReport | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  return typeof r.passed === 'boolean' &&
    typeof r.revision === 'string' &&
    Array.isArray(r.perVariant)
    ? (value as ValidationReport)
    : null;
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

/** AI reference solutions of ONE version (they are per version; a new version starts with none). */
export function useAiReferences(id: string, version: number) {
  return useQuery({
    queryKey: questionKeys.ai(id, version),
    // No question yet (create mode, or a type without AI solutions): no request.
    enabled: id !== '' && version > 0,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/v1/questions/{questionId}/versions/{version}/ai-references',
        { params: { path: { questionId: id, version } } },
      );
      if (!data) fail(response, error);
      return data;
    },
  });
}

/** Add a row, or supersede one (retire it and insert the replacement in one call). */
export function useAddAiReference(id: string, version: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { body: Schemas['CreateAiReference']; supersedes?: string }) => {
      if (vars.supersedes) {
        const r = await api.POST(
          '/v1/questions/{questionId}/versions/{version}/ai-references/{aiReferenceId}/supersede',
          {
            params: { path: { questionId: id, version, aiReferenceId: vars.supersedes } },
            body: { replacement: vars.body },
          },
        );
        if (!r.data) fail(r.response, r.error);
        return r.data;
      }
      const r = await api.POST('/v1/questions/{questionId}/versions/{version}/ai-references', {
        params: { path: { questionId: id, version } },
        body: vars.body,
      });
      if (!r.data) fail(r.response, r.error);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: questionKeys.ai(id, version) }),
  });
}

export type AiPolicy = Schemas['AiPolicy'];

/**
 * The organisation's AI reference policy (`GET /questions/ai-policy`, permission ai_reference:read:
 * Author and Super Admin). Nobody else gets it: a role without the permission never makes the
 * call (the API would answer 403). The key carries the user id and the whole cache is cleared on
 * a user or role change, so one person's answer is never shown to another.
 */
export function useAiPolicy(enabled = true) {
  const { user, role } = useAuth();
  return useQuery({
    queryKey: questionKeys.aiPolicy(user?.id ?? ''),
    enabled: enabled && user !== null && can(role, 'ai_reference:read'),
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions/ai-policy');
      if (!data) fail(response, error);
      return data;
    },
  });
}
