// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/console/',
  plugins: [react()],
  resolve: {
    // bundle workspace packages from source (their "development" export condition)
    conditions: ['development', 'module', 'browser', 'default'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.OPENDC_API ?? 'http://127.0.0.1:18443', changeOrigin: false } },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
