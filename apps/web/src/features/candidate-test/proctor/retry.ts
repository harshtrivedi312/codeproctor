import type { ApiResult } from '@/features/candidate-flow/api';

/**
 * Retries a candidate call a few times on a network failure, a 5xx or a 429, honouring
 * Retry-After (capped), before the caller gives up and ends the session (S-6). Anything else
 * (401, 4xx with a code) is final at once.
 */
export async function withRetry<T>(
  call: () => Promise<ApiResult<T>>,
  options: { tries?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ApiResult<T>> {
  const tries = options.tries ?? 3;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: ApiResult<T> | null = null;
  for (let i = 0; i < tries; i += 1) {
    last = await call();
    if (last.ok) return last;
    const transient =
      last.kind !== 'problem' || last.status === 429 || last.status >= 500 || last.status === 408;
    if (!transient || i === tries - 1) return last;
    const wait =
      last.kind === 'problem' && last.retryAfterSeconds !== null
        ? Math.min(maxWaitMs, last.retryAfterSeconds * 1000)
        : Math.min(maxWaitMs, 400 * 2 ** i);
    await sleep(wait);
  }
  return last as ApiResult<T>;
}
