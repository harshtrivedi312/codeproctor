/*
 * MOCK content revision. The real API's `revision` is an opaque SHA-256 over the version content
 * and test cases (apps/api/src/questions/revision.ts). This mock uses a simple deterministic digest
 * instead (four cyrb53-style rounds, 64 hex characters, so it has the same format). It depends on
 * exactly the same inputs: the content and the test cases, not the tags and not the variants. It
 * changes when the content changes and not otherwise. It is NOT a cryptographic hash.
 */

export interface RevisionInput {
  title: string;
  statementMd: string;
  difficulty: string;
  allowedLanguages: readonly string[];
  limits: unknown;
  starterCode: unknown;
  referenceSolution: unknown;
  answerSpec: unknown;
  testCases: readonly {
    id: string;
    position: number;
    isHidden: boolean;
    weight: number;
    input: string;
    expectedOutput: string;
  }[];
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function mockRevision(v: RevisionInput): string {
  const sorted = [...v.testCases].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const body = JSON.stringify(
    canonical({
      title: v.title,
      statementMd: v.statementMd,
      difficulty: v.difficulty,
      allowedLanguages: v.allowedLanguages,
      limits: v.limits,
      starterCode: v.starterCode,
      referenceSolution: v.referenceSolution,
      answerSpec: v.answerSpec ?? null,
      testCases: sorted,
    }),
  );
  return [1, 2, 3, 4]
    .map((seed) => cyrb53(body, seed).toString(16).padStart(16, '0').slice(-16))
    .join('');
}
