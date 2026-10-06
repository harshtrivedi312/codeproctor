/**
 * Resolves when the MSW browser worker is active (or immediately when mocking is off), so API
 * calls made during the first render never race ahead of the worker. A failed or very slow mock
 * start cannot block the app forever: the wait gives up after MOCK_READY_TIMEOUT_MS and the
 * request goes out unmocked (it then fails like any offline call, with the normal error states).
 */
import { mockingEnabled } from './env';

export const MOCK_READY_TIMEOUT_MS = 5_000;

let resolve: () => void = () => undefined;
export const mockingReady: Promise<void> = mockingEnabled
  ? new Promise<void>((r) => {
      resolve = r;
      setTimeout(r, MOCK_READY_TIMEOUT_MS);
    })
  : Promise.resolve();

export function markMockingReady(): void {
  resolve();
}
