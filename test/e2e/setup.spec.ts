// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Setup wizard (acceptance 1 and 6). Runs only against an unprovisioned node:
 *   OPENDC_SETUP_URL=https://<node>/ OPENDC_SETUP_TOKEN=... OPENDC_SETUP_ROLE=primary-dc|dc
 *   OPENDC_SETUP_FQDN=dc1.example.test OPENDC_SETUP_FORWARDER=1.1.1.1 OPENDC_ADMIN_PASSWORD=...
 *   (join: OPENDC_SETUP_DC=<existing DC address>)
 */
import { expect, test } from '@playwright/test';
import { adminPassword, expectAccessible } from './helpers.ts';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};

test.skip(!process.env.OPENDC_SETUP_URL, 'no unprovisioned node given (OPENDC_SETUP_URL)');

test('setup wizard: token, role, host and domain, administrator, pre-flight, run', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const role = process.env.OPENDC_SETUP_ROLE === 'dc' ? 'dc' : 'primary-dc';
  const fqdn = env('OPENDC_SETUP_FQDN');
  const domain = fqdn.split('.').slice(1).join('.');
  const started = Date.now();

  await page.goto(new URL('console/', env('OPENDC_SETUP_URL')).toString());
  await expect(page.getByRole('heading', { name: 'Set up OpenDC' })).toBeVisible();
  await expectAccessible(page, 'setup: token');
  await page.getByLabel('Setup token').fill('wrong-token');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Setup token').fill(env('OPENDC_SETUP_TOKEN'));
  await page.getByRole('button', { name: 'Next' }).click();

  // role
  await page
    .getByLabel(
      role === 'dc'
        ? 'An additional domain controller of an existing domain'
        : 'The first domain controller of a new domain',
    )
    .check();
  await expectAccessible(page, 'setup: role');
  await page.getByRole('button', { name: 'Next' }).click();

  // host and domain
  await page.getByLabel('Host name (FQDN)').fill(fqdn);
  await page.getByLabel('DNS forwarders').fill(process.env.OPENDC_SETUP_FORWARDER ?? '');
  if (role === 'dc') {
    await page.getByLabel('Existing domain controller').fill(env('OPENDC_SETUP_DC'));
    await page.getByLabel('Its password').fill(adminPassword());
  }
  await expectAccessible(page, 'setup: host');
  await page.getByRole('button', { name: 'Next' }).click();

  if (role === 'primary-dc') {
    await page.getByRole('textbox', { name: 'Administrator password', exact: true }).fill(adminPassword());
    await page.getByLabel('Repeat the password').fill(adminPassword());
    await page.getByRole('button', { name: 'Next' }).click();
  }

  // pre-flight and confirmation
  await page.getByRole('button', { name: 'Run the pre-flight checks' }).click();
  await expect(page.getByText(/is configured on this host/)).toBeVisible({ timeout: 120_000 });
  await expectAccessible(page, 'setup: pre-flight');
  await page.getByLabel(`Type ${domain} to confirm`).fill(domain);
  await page.getByRole('button', { name: role === 'dc' ? 'Join the domain' : 'Create the domain' }).click();

  await expect(
    page
      .getByRole('heading', { name: 'Done' })
      .or(page.getByText('Done', { exact: true }))
      .first(),
  ).toBeVisible({
    timeout: 15 * 60_000,
  });
  const minutes = (Date.now() - started) / 60_000;
  test.info().annotations.push({ type: 'duration', description: `${minutes.toFixed(1)} min` });
  expect(minutes, 'acceptance 1: set up within 15 minutes').toBeLessThan(15);
});
