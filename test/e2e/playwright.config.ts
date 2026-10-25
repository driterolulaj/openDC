// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End-to-end tests against a running lab console (ROADMAP Phase 2 acceptance 6). Not part of `npm run check`:
 *   OPENDC_URL=https://<console>/ OPENDC_ADMIN_PASSWORD=... [OPENDC_ADMIN_USER=<a Domain Admin>] npm run e2e
 * Setup wizard test additionally: OPENDC_SETUP_URL (an unprovisioned node) and OPENDC_SETUP_TOKEN.
 * The console certificate is self-signed until the domain CA exists (Phase 3), so TLS errors are ignored.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../.e2e-results',
  use: {
    baseURL: process.env.OPENDC_URL ?? 'https://127.0.0.1:8443/',
    ignoreHTTPSErrors: true,
    // a missing element fails the step instead of waiting for the whole test timeout
    actionTimeout: 30_000,
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
