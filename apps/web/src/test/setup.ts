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
});

// jsdom has no Web Locks. Real browsers do, so the refresh runs through the lock path here too.
if (typeof navigator !== 'undefined' && !navigator.locks) {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createFakeLocks() });
}
