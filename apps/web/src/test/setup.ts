import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { createFakeLocks } from './fake-web-locks';

// CI runners are slower than laptops; the 1 s default made `findBy*` flake on loading tables.
configure({ asyncUtilTimeout: 5000 });

expect.extend(axeMatchers);

afterEach(() => {
  cleanup();
  // A fresh lock manager per test: a test that left a lock held cannot stall the next one.
  if (typeof navigator !== 'undefined') installFakeLocks();
});

// jsdom has no Web Locks. Real browsers do, so the refresh runs through the lock path here too.
function installFakeLocks(): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createFakeLocks() });
}
if (typeof navigator !== 'undefined') installFakeLocks();
