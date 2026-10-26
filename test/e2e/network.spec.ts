// SPDX-License-Identifier: AGPL-3.0-only
/** Phase 3 pages: each loads without an error and passes the accessibility check, every DHCP tab included. */
import { expect, test } from '@playwright/test';
import { expectAccessible, login } from './helpers.ts';

test('network services pages', async ({ page }) => {
  await login(page);
  for (const name of ['Policies', 'DNS', 'Certificates', 'Group policy', 'DHCP']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expectAccessible(page, name);
  }
  for (const tab of ['Services', 'Leases (this node)', 'Subnets']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await expectAccessible(page, `DHCP ${tab}`);
  }
});
