import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests read the shared package from source so they do not depend on a prior build.
      '@codeproctor/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
});
