import { afterEach, beforeEach } from 'vitest';

// The event queue keeps a small sequence-counter backup in localStorage; tests reuse session ids,
// so every test starts and ends with an empty localStorage.
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => globalThis.localStorage?.clear());
