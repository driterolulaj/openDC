// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import opendc from './tools/eslint-plugin-opendc/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/generated/**',
      'packages/web/vite.config.ts',
      '**/*.cjs',
      'packaging/out/**',
      'packaging/.cache/**',
      'coverage/**',
      // Phase 0 design drafts; the real code lives in packages/*
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { opendc },
    rules: {
      'opendc/no-shell-exec': 'error',
      'opendc/no-raw-ldap': 'error',
      'opendc/no-distro-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // style-only rules from strictTypeChecked that don't catch bugs in this codebase
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['packages/web/src/**/*.tsx', 'modules/*/web/**/*.tsx'],
    rules: { 'opendc/no-literal-jsx-text': 'error' },
  },
  {
    // Tests may assert on literal values (distro ids in os fixtures are inside packages/os already).
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.lab.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // fake OS facts in tests legitimately name a distribution
      'opendc/no-distro-check': 'off',
    },
  },
  {
    files: ['**/*.js', 'tools/**'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // build tooling runs tar/nfpm/npm; exec, execSync and shell: true stay banned
    files: ['packaging/**/*.ts', 'test/env/**/*.ts'],
    rules: { 'opendc/no-shell-exec': ['error', { allowImport: true }] },
  },
  {
    // the rule definitions list the very literals they look for
    files: ['tools/eslint-plugin-opendc/**'],
    rules: { 'opendc/no-distro-check': 'off', 'opendc/no-raw-ldap': 'off' },
  },
);
