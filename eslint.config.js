// Root ESLint flat config shared by every workspace package.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/cdk.out/**',
      '**/reports/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      // CI scratch dirs inside the project dir (pnpm store, tool caches, OCI archives).
      '.cache/**',
      '.pnpm-store/**',
      'oci-out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // CLI scripts, tooling and test harnesses may print to stdout.
    files: [
      'tools/**/*.{ts,js,mjs}',
      'scripts/**/*.{ts,js,mjs}',
      'infra/bin/**/*.ts',
      'tests/**/*.{ts,js}',
      'policies/**/*.{ts,js}',
      'platform/**/*.{ts,js,mjs}',
    ],
    rules: { 'no-console': 'off' },
  },
);
