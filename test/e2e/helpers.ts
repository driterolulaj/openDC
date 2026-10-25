// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const adminPassword = (): string => {
  const pw = process.env.OPENDC_ADMIN_PASSWORD;
  if (!pw) throw new Error('Set OPENDC_ADMIN_PASSWORD');
  return pw;
};

export async function login(page: Page, user = 'Administrator', password = adminPassword()): Promise<void> {
  await page.goto('console/');
  await page.getByLabel('User name').fill(user);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

/** No serious or critical axe violations (WCAG 2.1 AA). */
export async function expectAccessible(page: Page, context: string): Promise<void> {
  // let CSS transitions (navigation highlight, modals) finish; axe measures the colors it sees
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    `axe violations on ${context}`,
  ).toEqual([]);
}

export const unique = (prefix: string): string => `${prefix}${Date.now().toString(36).slice(-6)}`;
