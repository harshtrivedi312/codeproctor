import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';

/** Node (Vitest) server with zero simulated latency. */
export const server = setupServer(
  ...createHandlers({ runLatencyMs: 0, saveLatencyMs: 0, adminLatencyMs: 0 }),
);
