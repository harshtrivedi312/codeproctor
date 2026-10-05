import type { WorkerLike } from './inference-client';

/** Bundlers (Next.js, Vite) turn this into a separate worker chunk. */
export function createDefaultInferenceWorker(): WorkerLike {
  return new Worker(new URL('./worker/inference.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}
