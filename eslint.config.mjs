import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  globalIgnores(['.next/**', '.next-e2e/**', '.playwright-mcp/**', 'out/**', 'build/**', 'next-env.d.ts', 'data/**', 'playwright-report/**', 'test-results/**', 'public/sw.js']),
]);
