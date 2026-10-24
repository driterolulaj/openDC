// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console sessions (SECURITY.md §4): 256-bit random id in the __Host-opendc_sid cookie, stored as SHA-256;
 * idle and absolute timeouts; CSRF token = HMAC(key, session id), so no CSRF secret is stored either.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlatformDb } from '@opendc/shared/db';

export const SESSION_COOKIE = '__Host-opendc_sid';

export interface SessionUser {
  sid: string;
  guid: string;
  username: string;
  displayName: string | null;
  dn: string;
  domainSid: string;
  groupSids: string[];
}

export interface Session extends SessionUser {
  idHash: string;
  createdAt: number;
  lastSeen: number;
  groupsAt: number;
  ip: string | null;
}

interface Row {
  id_hash: string;
  user_sid: string;
  user_guid: string;
  username: string;
  display_name: string | null;
  user_dn: string;
  domain_sid: string;
  group_sids: string;
  groups_at: number;
  created_at: number;
  last_seen: number;
  ip: string | null;
}

const hashId = (id: string): string => createHash('sha256').update(id).digest('hex');

export interface SessionOptions {
  idleMs: number;
  absoluteMs: number;
  csrfKey: Buffer;
  now?: () => number;
}

export class SessionStore {
  readonly #db: PlatformDb;
  readonly #o: Required<SessionOptions>;

  constructor(db: PlatformDb, o: SessionOptions) {
    this.#db = db;
    this.#o = { now: Date.now, ...o };
  }

  create(user: SessionUser, ip: string | null): { id: string; session: Session } {
    const id = randomBytes(32).toString('base64url');
    const now = this.#o.now();
    const session: Session = { ...user, idHash: hashId(id), createdAt: now, lastSeen: now, groupsAt: now, ip };
    this.#db.run(
      `INSERT INTO sessions (id_hash, user_sid, user_guid, username, display_name, user_dn, domain_sid, group_sids, groups_at, created_at, last_seen, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.idHash,
        user.sid,
        user.guid,
        user.username,
        user.displayName,
        user.dn,
        user.domainSid,
        JSON.stringify(user.groupSids),
        now,
        now,
        now,
        ip,
      ],
    );
    return { id, session };
  }

  /** The live session for a cookie value, or null (unknown, idle or past its absolute lifetime). */
  get(id: string | undefined): Session | null {
    if (!id || id.length > 100) return null;
    const idHash = hashId(id);
    const r = this.#db.get<Row>('SELECT * FROM sessions WHERE id_hash = ?', [idHash]);
    if (!r) return null;
    const now = this.#o.now();
    if (now - r.last_seen > this.#o.idleMs || now - r.created_at > this.#o.absoluteMs) {
      this.#db.run('DELETE FROM sessions WHERE id_hash = ?', [idHash]);
      return null;
    }
    // Touch at most once a minute to keep writes low.
    const touched = now - r.last_seen > 60_000;
    if (touched) this.#db.run('UPDATE sessions SET last_seen = ? WHERE id_hash = ?', [now, idHash]);
    return {
      idHash,
      sid: r.user_sid,
      guid: r.user_guid,
      username: r.username,
      displayName: r.display_name,
      dn: r.user_dn,
      domainSid: r.domain_sid,
      groupSids: JSON.parse(r.group_sids) as string[],
      groupsAt: r.groups_at,
      createdAt: r.created_at,
      lastSeen: touched ? now : r.last_seen,
      ip: r.ip,
    };
  }

  destroy(id: string | undefined): void {
    if (id) this.#db.run('DELETE FROM sessions WHERE id_hash = ?', [hashId(id)]);
  }

  purgeExpired(): number {
    const now = this.#o.now();
    return this.#db.run('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?', [
      now - this.#o.idleMs,
      now - this.#o.absoluteMs,
    ]).changes;
  }

  csrfToken(id: string): string {
    return createHmac('sha256', this.#o.csrfKey).update('csrf\0').update(id).digest('base64url');
  }

  checkCsrf(id: string, token: string | undefined): boolean {
    if (!token) return false;
    const want = Buffer.from(this.csrfToken(id));
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }
}
