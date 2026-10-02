/**
 * Resolves when the MSW browser worker is active (or immediately when mocking is off), so API
 * calls made during the first render never race ahead of the worker.
 */
import { mockingEnabled } from './env';

let resolve: () => void = () => undefined;
export const mockingReady: Promise<void> = mockingEnabled
  ? new Promise<void>((r) => {
      resolve = r;
    })
  : Promise.resolve();

export function markMockingReady(): void {
  resolve();
}
