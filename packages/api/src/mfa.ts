// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TOTP second factor (SECURITY.md §4, ADR-0020): RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step) with node:crypto.
 * Recovery codes are stored as SHA-256 hashes and work once. A code can't be replayed within its window.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PlatformObjects, type Stored } from './directory/platform-objects.ts';
import type { DirectoryService } from './directory/service.ts';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new TypeError('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for counter `step`. */
export function hotp(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const totpStep = (nowMs = Date.now()): number => Math.floor(nowMs / 30_000);

/** The matching time step (±1) or null. */
export function verifyTotp(secret: Buffer, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const totpData = z.object({
  sid: z.string(),
  /** base32 seed */
  seed: z.string(),
  confirmedAt: z.string().nullable(),
  recovery: z.array(z.string()),
  lastStep: z.number().nullable(),
});

/**
 * Enrolments live in the directory (CN=MFA,CN=OpenDC,CN=System), so they work on every DC. That container
 * has a protected DACL readable only by the OpenDC platform services group, Domain Admins and SYSTEM (set at
 * provisioning), the same way AD keeps credential material confidential. Replay protection (lastStep) is
 * per object and therefore domain-wide, modulo replication delay.
 */
export class TotpStore {
  readonly #store: PlatformObjects<typeof totpData>;

  constructor(dir: () => DirectoryService) {
    this.#store = new PlatformObjects({
      dir,
      path: ['MFA'],
      kind: 'mfa.totp',
      schemaVersion: 1,
      data: totpData,
      name: (d) => d.sid,
    });
  }

  async #find(sid: string): Promise<Stored<z.output<typeof totpData>> | null> {
    return (await this.#store.list()).find((x) => x.data.sid === sid) ?? null;
  }

  async enrolled(sid: string): Promise<boolean> {
    return (await this.#find(sid))?.data.confirmedAt != null;
  }

  /** Starts (or restarts) enrolment: returns the secret to show once; not active until confirmed. */
  async begin(sid: string): Promise<string> {
    const seed = base32Encode(randomBytes(20));
    const data = { sid, seed, confirmedAt: null, recovery: [], lastStep: null };
    const cur = await this.#find(sid);
    const actor = { sid, name: sid };
    if (cur) await this.#store.update(actor, cur, data);
    else await this.#store.create(actor, data);
    return seed;
  }

  /** Confirms enrolment with a first code; returns 10 recovery codes (shown once). */
  async confirm(sid: string, code: string): Promise<string[] | null> {
    const cur = await this.#find(sid);
    if (!cur) return null;
    const step = verifyTotp(base32Decode(cur.data.seed), code);
    if (step === null) return null;
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex'));
    await this.#store.update({ sid, name: sid }, cur, {
      ...cur.data,
      confirmedAt: new Date().toISOString(),
      recovery: codes.map(sha256),
      lastStep: step,
    });
    return codes;
  }

  /** Checks a TOTP or recovery code for an enrolled user (consumes recovery codes; no replays). */
  async check(sid: string, code: string): Promise<boolean> {
    const cur = await this.#find(sid);
    if (!cur?.data.confirmedAt) return false;
    const c = code.trim().replace(/\s/g, '').toLowerCase();
    const step = verifyTotp(base32Decode(cur.data.seed), c);
    if (step !== null) {
      if (cur.data.lastStep !== null && step <= cur.data.lastStep) return false;
      await this.#store.update({ sid, name: sid }, cur, { ...cur.data, lastStep: step });
      return true;
    }
    const h = sha256(c);
    if (!cur.data.recovery.includes(h)) return false;
    await this.#store.update({ sid, name: sid }, cur, {
      ...cur.data,
      recovery: cur.data.recovery.filter((x) => x !== h),
    });
    return true;
  }

  async remove(sid: string): Promise<void> {
    const cur = await this.#find(sid);
    if (cur) await this.#store.delete(cur);
  }
}
