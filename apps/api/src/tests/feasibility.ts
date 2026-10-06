// Can a test's random slots all get their own question? (FR-301, TC-020; FU-BE-116.) Pure, no I/O.
//
// A test never shows one question twice, and test start (candidate TestStartService, BE-07) takes
// every fixed question first and never picks one of those again at random. So the slots must have
// a system of distinct representatives: each random slot gets one question that matches its rule,
// no two slots share one, and none is a question a fixed slot already uses. That is a bipartite
// matching between random slots and the matching questions; it is solved here with augmenting
// paths (Kuhn), O(slots x edges). Checking each rule alone is not enough: two `{tags:[a]}` slots
// plus one `{tags:[a,b]}` slot with only two matching questions pass rule by rule and still fail.
//
// Bounds: a test has at most MAX_QUESTIONS_PER_TEST slots, and the caller reads at most
// candidateCap() ids per distinct rule. Keeping only that many per rule never changes the answer:
// a slot whose list still has `random slots + fixed questions` ids after the fixed ones are removed
// can always be served, whatever the other slots take.
import { MAX_QUESTIONS_PER_TEST } from './test-structure';

/** Ids to read per distinct rule: enough that truncating a rule's matches cannot change the result. */
export function candidateCap(randomSlots: number, fixedQuestions: number): number {
  return randomSlots + fixedQuestions;
}

/**
 * `options[i]` lists the question ids that match slot i's rule. Fixed questions are removed here
 * (`taken`). Returns the indexes of the slots that cannot get a question of their own in a best
 * possible assignment; an empty list means the test is satisfiable.
 */
export function unservedSlots(
  options: readonly (readonly string[])[],
  taken: ReadonlySet<string> = new Set(),
): number[] {
  if (options.length > MAX_QUESTIONS_PER_TEST) {
    throw new RangeError(`at most ${MAX_QUESTIONS_PER_TEST} slots`);
  }
  const free = options.map((o) => [...new Set(o)].filter((id) => !taken.has(id)));
  const owner = new Map<string, number>(); // question id -> slot that holds it
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
  // Fewest options first: the usual heuristic, and it makes the common case one pass.
  const order = free
    .map((_, i) => i)
    .sort((a, b) => (free[a]?.length ?? 0) - (free[b]?.length ?? 0));
  const unserved: number[] = [];
  for (const slot of order) if (!augment(slot, new Set())) unserved.push(slot);
  return unserved.sort((a, b) => a - b);
}
