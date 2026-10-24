// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import opendc from './tools/eslint-plugin-opendc/index.js';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**', 'packages/web/vite.config.ts', 'coverage/**'] },
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
    },
  },
  {
    files: ['packages/web/src/**/*.tsx', 'modules/*/web/**/*.tsx'],
    rules: { 'opendc/no-literal-jsx-text': 'error' },
  },
  {
    // Tests may assert on literal values (distro ids in os fixtures are inside packages/os already).
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['**/*.js', 'tools/**'],
    ...tseslint.configs.disableTypeChecked,
  },
);
