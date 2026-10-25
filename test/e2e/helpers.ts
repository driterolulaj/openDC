// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const adminPassword = (): string => {
  const pw = process.env.OPENDC_ADMIN_PASSWORD;
  if (!pw) throw new Error('Set OPENDC_ADMIN_PASSWORD');
  return pw;
};

// ---- TOTP for test accounts (the secret is captured at enrolment and kept for this test run) ----

const STATE = join(import.meta.dirname, '../../.e2e-results/totp.json');
type TotpState = Record<string, { secret: string; lastStep: number }>;
const readState = (): TotpState => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as TotpState) : {});
const writeState = (s: TotpState): void => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s));
};

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function code(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 15;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** A code for a step not used before (the server refuses replays within a window). */
export async function nextTotp(user: string): Promise<string | null> {
  const state = readState();
  const entry = state[user];
  if (!entry) return null;
  let step = Math.floor(Date.now() / 30_000);
  if (step <= entry.lastStep) {
    await new Promise((r) => setTimeout(r, (entry.lastStep + 1) * 30_000 - Date.now() + 500));
    step = entry.lastStep + 1;
  }
  state[user] = { ...entry, lastStep: step };
  writeState(state);
  return code(entry.secret, step);
}

function remember(user: string, secret: string): void {
  const state = readState();
  state[user] = { secret, lastStep: Math.floor(Date.now() / 30_000) - 1 };
  writeState(state);
}

/** Signs in; enrols an authenticator first if the role requires one; answers the code prompt. */
export async function login(page: Page, user = 'Administrator', password = adminPassword()): Promise<void> {
  await page.goto('console/');
  await page.getByLabel('User name').fill(user);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const codeField = page.getByLabel('Authenticator code');
  const enrol = page.getByRole('heading', { name: 'Set up a second factor' });
  const done = page.getByRole('button', { name: 'Log out' });
  await expect(codeField.or(enrol).or(done).first()).toBeVisible();
  if (await codeField.isVisible()) {
    const c = await nextTotp(user);
    if (!c)
      throw new Error(`${user} has a second factor this test run doesn't know; reset it (DELETE /accounts/<sid>/totp)`);
    await codeField.fill(c);
    await page.getByRole('button', { name: 'Sign in' }).click();
  } else if (await enrol.isVisible()) {
    await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
    const secret = (await page.getByLabel('Secret').innerText()).trim();
    remember(user, secret);
    const c = await nextTotp(user);
    await page.getByLabel('Authenticator code').fill(c ?? '');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('The authenticator app is set up.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
  }
  await expect(done).toBeVisible();
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
