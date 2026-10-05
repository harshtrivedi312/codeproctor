/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // These options are laid over apps/api/tsconfig.json (ts-jest finds it from rootDir).
        // The generated Prisma client loads its query compiler with a dynamic import(). With
        // `module: NodeNext` ts-jest keeps import() as it is, and Jest refuses to run it without
        // --experimental-vm-modules. `module: commonjs` turns it into require(), which Jest runs.
        // The real build (tsconfig.build.json) is unchanged.
        tsconfig: { module: 'commonjs', moduleResolution: 'bundler' },
      },
    ],
  },
  // The generated Prisma client imports its own files with a .js suffix (ADR 0009 section 4.2), and
  // so does create-prisma-client.ts. tsc maps those to the .ts sources; Jest needs the same mapping.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  // Testcontainers start Postgres and Redis, which can take a while on a cold image cache.
  testTimeout: 120000,
};
