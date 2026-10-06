// Gives every random slot of a test its own question (FR-203, FR-301, TC-020). Pure, no I/O.
//
// The save-time check (tests/feasibility.ts `unservedSlots`) is an exact bipartite matching, so a
// test it accepts can always be served; picking greedily slot by slot can fail on such a test
// (rules {tags:[a]} and {tags:[a,b]} with exactly two matching questions). This uses the same
// matching (Kuhn, augmenting paths, fewest options first) to build the assignment, so it succeeds
// exactly when the save-time check does. Variety: each slot's candidates are shuffled with a PRNG
// seeded by the session id before matching, so different candidates get different questions while
// the same session always gets the same ones (a retried start never changes a candidate's test).
import { createHash } from 'node:crypto';

/** mulberry32: a small seeded PRNG, enough for a reproducible shuffle (not a security control). */
function prng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * `options[i]` lists the question ids that match slot i (any order); `taken` are the fixed
 * questions. Returns, per slot, the question it gets, or null for a slot that cannot be served in
 * any assignment (`null` slots are exactly the unserved ones of a maximum matching).
 */
export function assignDistinct(
  options: readonly (readonly string[])[],
  taken: ReadonlySet<string>,
  seed: string,
): (string | null)[] {
  const random = prng(seed);
  const free = options.map((o) =>
    shuffled([...new Set(o)].filter((id) => !taken.has(id)).sort(), random),
  );
  const owner = new Map<string, number>();
  const augment = (slot: number, seen: Set<string>): boolean => {
    for (const id of free[slot] ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const holder = owner.get(id);
      if (holder === undefined || augment(holder, seen)) {
        owner.set(id, slot);
        return true;
      }
    }
    return false;
  };
  const order = free
    .map((_, i) => i)
    .sort((a, b) => (free[a]?.length ?? 0) - (free[b]?.length ?? 0) || a - b);
  for (const slot of order) augment(slot, new Set());
  const result: (string | null)[] = options.map(() => null);
  for (const [id, slot] of owner) result[slot] = id;
  return result;
}
