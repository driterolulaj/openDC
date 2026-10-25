// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The one-time setup token (agent-operations.md §5). Created at install time while the host isn't part of a
 * domain, shown on the console and in the journal, and destroyed when provisioning or join completes.
 * Callers on the api socket must present it for setup operations; the agent compares SHA-256 digests in
 * constant time, so neither timing nor length leaks the token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const SETUP_TOKEN_FILE = 'setup-token';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Human-friendly: 5 groups of 5 from an alphabet without look-alikes (~116 bits). */
export function newSetupToken(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(25);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length] ?? 'a');
  const groups: string[] = [];
  for (let i = 0; i < 25; i += 5) groups.push(chars.slice(i, i + 5).join(''));
  return groups.join('-');
}

export class SetupToken {
  readonly #path: string;

  constructor(secretsDir: string) {
    this.#path = join(secretsDir, SETUP_TOKEN_FILE);
  }

  async read(): Promise<string | null> {
    const t = (await readFile(this.#path, 'utf8').catch(() => '')).trim();
    return t || null;
  }

  /** Creates the token if it doesn't exist yet; returns it. */
  async ensure(): Promise<string> {
    const existing = await this.read();
    if (existing) return existing;
    const token = newSetupToken();
    const fh = await open(this.#path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await fh.writeFile(token + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    return token;
  }

  async verify(presented: string | undefined): Promise<boolean> {
    const want = await this.read();
    if (!want || !presented) return false;
    // tolerate copy/paste: case, surrounding blanks, missing or extra dashes
    const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s-]/g, '');
    return timingSafeEqual(digest(norm(presented)), digest(norm(want)));
  }

  async destroy(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
