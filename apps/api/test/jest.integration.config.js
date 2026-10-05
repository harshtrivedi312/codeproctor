/**
 * QA integration suite (docs/test-matrix.md). Files: test/integration/tc-NNN.int.test.ts.
 * Run from the repo root:
 *   pnpm --filter @codeproctor/api exec node --experimental-vm-modules node_modules/jest/bin/jest.js -c test/jest.integration.config.js --runInBand --forceExit
 * On a fresh checkout run `pnpm --filter @codeproctor/shared build` (or `pnpm --filter @codeproctor/api... build`) first:
 * @codeproctor/shared resolves through its built dist.
 * Every file starts its own throwaway Postgres 16 and Redis through Testcontainers and applies
 * prisma/migrations. It never reads DATABASE_URL from the environment or touches the dev stack.
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.int\\.test\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }] },
  testEnvironment: 'node',
  // The generated Prisma client imports its own files with a .js suffix; map them to the .ts sources.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testTimeout: 120000,
};
