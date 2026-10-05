// A small deterministic PRNG for generated test inputs. The same seed always gives the same input,
// on every machine, so seeded test data never changes between runs.

/** mulberry32: returns a function that yields numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi]. */
export function randomInt(random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** `count` integers in [lo, hi]. */
export function randomInts(random: () => number, count: number, lo: number, hi: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(randomInt(random, lo, hi));
  return values;
}

/** Fisher-Yates shuffle of a copy. */
export function shuffled<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(random, 0, i);
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}

/** Whitespace-separated tokens of a test input. */
export function tokens(input: string): string[] {
  return input.split(/\s+/).filter((token) => token !== '');
}
