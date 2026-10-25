// SPDX-License-Identifier: AGPL-3.0-only
/**
 * API tokens for the CLI and automation (SECURITY.md §4). A token acts as the user who created it, with the
 * group memberships of that moment and optionally fewer permissions; it never carries tier-0 rights. Stored
 * in the directory (CN=APITokens, confidential) so it works on every DC; only SHA-256 of the secret is kept,
 * and the token itself is shown once. Format: odc_<id>_<secret>.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PlatformObjects, type Stored } from './directory/platform-objects.ts';
import type { DirectoryService } from './directory/service.ts';
import type { SessionUser } from './sessions.ts';

const tokenData = z.object({
  name: z.string(),
  secretHash: z.string(),
  user: z.object({
    sid: z.string(),
    guid: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    dn: z.string(),
    domainSid: z.string(),
    groupSids: z.array(z.string()),
  }),
  /** null = all of the user's (non-tier-0) permissions */
  permissions: z.array(z.string()).nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TokenData = z.infer<typeof tokenData>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const TOKEN = /^odc_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;

export class TokenStore {
  readonly #store: PlatformObjects<typeof tokenData>;
  #cache: { at: number; items: Stored<TokenData>[] } | null = null;

  constructor(dir: () => DirectoryService) {
    this.#store = new PlatformObjects({
      dir,
      path: ['APITokens'],
      kind: 'apiToken',
      schemaVersion: 1,
      data: tokenData,
      name: (d) => `${d.user.username}: ${d.name}`,
    });
  }

  async #list(fresh = false): Promise<Stored<TokenData>[]> {
    if (!fresh && this.#cache && Date.now() - this.#cache.at < 60_000) return this.#cache.items;
    const items = await this.#store.list();
    this.#cache = { at: Date.now(), items };
    return items;
  }

  async create(
    user: SessionUser,
    o: { name: string; days: number; permissions: string[] | null },
  ): Promise<{ id: string; token: string }> {
    const secret = randomBytes(32).toString('base64url');
    const now = new Date();
    const id = await this.#store.create(
      { sid: user.sid, name: user.username },
      {
        name: o.name,
        secretHash: sha256(secret),
        user: {
          sid: user.sid,
          guid: user.guid,
          username: user.username,
          displayName: user.displayName,
          dn: user.dn,
          domainSid: user.domainSid,
          groupSids: user.groupSids,
        },
        permissions: o.permissions,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + o.days * 86_400_000).toISOString(),
      },
    );
    this.#cache = null;
    return { id, token: `odc_${id}_${secret}` };
  }

  /** The token's identity, or null (unknown, wrong secret, expired). */
  async verify(token: string): Promise<(Stored<TokenData> & { data: TokenData }) | null> {
    const m = TOKEN.exec(token.trim());
    if (!m) return null;
    const [, id = '', secret = ''] = m;
    let item = (await this.#list()).find((x) => x.id === id);
    item ??= (await this.#list(true)).find((x) => x.id === id);
    if (!item) return null;
    const a = Buffer.from(sha256(secret));
    const b = Buffer.from(item.data.secretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Date.parse(item.data.expiresAt) < Date.now()) return null;
    return item;
  }

  async listFor(sid: string): Promise<Stored<TokenData>[]> {
    return (await this.#list(true)).filter((x) => x.data.user.sid === sid);
  }

  async revoke(sid: string, id: string, any = false): Promise<boolean> {
    const item = (await this.#list(true)).find((x) => x.id === id && (any || x.data.user.sid === sid));
    if (!item) return false;
    await this.#store.delete(item);
    this.#cache = null;
    return true;
  }
}
