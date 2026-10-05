import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// CI runners are slower than laptops; the 1 s default made `findBy*` flake on loading tables.
configure({ asyncUtilTimeout: 5000 });

expect.extend(axeMatchers);

afterEach(() => {
  cleanup();
});
