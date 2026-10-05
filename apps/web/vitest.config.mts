import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Tests read the shared package from source so they do not depend on a prior build.
      '@codeproctor/proctor-sdk': fileURLToPath(
        new URL('../../packages/proctor-sdk/src/index.ts', import.meta.url),
      ),
      '@codeproctor/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // CI runners are slower than laptops; table tests wait for their loaded state, so give the whole test room.
    testTimeout: 30_000,
  },
});
