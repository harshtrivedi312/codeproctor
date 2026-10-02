// Base ESLint config for every TypeScript package in the monorepo (CLAUDE.md: no `any`).
// Type-aware rules use the nearest tsconfig.json of each file (projectService).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/node_modules/**',
    'apps/worker/**',
    // Generated or vendored: openapi-typescript output, MSW worker, self-hosted Monaco copy.
    'apps/web/src/lib/api/schema.d.ts',
    'apps/web/public/mockServiceWorker.js',
    'apps/web/public/monaco/**',
    'apps/web/next-env.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Web app: React hooks rules and accessibility lint (WCAG 2.1 AA, frontend.md rules).
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // Plain JavaScript (config files and infra/scripts) is not part of a TypeScript project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
