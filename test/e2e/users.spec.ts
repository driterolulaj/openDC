// SPDX-License-Identifier: AGPL-3.0-only
/** User lifecycle through the console: create, edit, disable, reset password, delete (acceptance 6). */
import { expect, test } from '@playwright/test';
import { expectAccessible, login, unique } from './helpers.ts';

test('user lifecycle', async ({ page }) => {
  await login(page);
  await expectAccessible(page, 'overview');

  await page.getByRole('link', { name: 'Directory' }).click();
  await expect(page.getByRole('heading', { name: 'Directory' })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expectAccessible(page, 'directory');

  // create
  const sam = unique('e2e');
  const last = `Tester-${sam}`;
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: 'User' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create user' });
  await dialog.getByLabel('First name').fill('Erika');
  await dialog.getByLabel('Last name').fill(last);
  await dialog.getByLabel('Account name').fill(sam);
  await dialog.getByRole('button', { name: 'Create' }).click();
  // generated password, shown once
  const secret = page.getByRole('dialog', { name: 'Generated password' });
  await expect(secret).toBeVisible();
  await expectAccessible(page, 'generated password');
  await secret.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: `Erika ${last}` })).toBeVisible();
  await expectAccessible(page, 'user view');

  // edit
  await page.getByLabel('Mail').fill(`${sam}@example.test`);
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled();
  await page.getByRole('tab', { name: 'Organization' }).click();
  await page.getByLabel('Department').fill('QA');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: 'Organization' }).click();
  await expect(page.getByLabel('Department')).toHaveValue('QA');

  // disable
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Disable' }).click();
  await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();

  // reset password (generated)
  await page.getByRole('button', { name: 'Reset password' }).click();
  await page.getByRole('dialog', { name: 'Reset password' }).getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('dialog', { name: 'Generated password' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // history shows what happened
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('directory.user.password-reset')).toBeVisible();
  await expect(page.getByText('directory.user.disable')).toBeVisible();

  // delete (typed confirmation)
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const del = page.getByRole('dialog', { name: 'Delete' });
  await del.getByLabel(/Type .* to confirm/).fill(`Erika ${last}`);
  await del.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Directory' })).toBeVisible();
});

test('domain page and tier-0 badge', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Domain' }).click();
  await expect(page.getByRole('heading', { name: 'FSMO roles' })).toBeVisible();
  await expectAccessible(page, 'domain');
  await page.getByRole('link', { name: 'Directory' }).click();
  await page.getByLabel('Search by name, account or mail').fill('Administrator');
  await page.getByRole('link', { name: 'Administrator', exact: true }).click();
  await expect(page.getByText('This is a protected (tier-0) object.')).toBeVisible();
});
