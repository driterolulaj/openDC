// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed confirmation tokens (agent-operations.md §1). After the user typed the confirmation phrase, the API
 * mints an HMAC over (op, canonical args, actor, expiry). The agent recomputes it, so a request can't carry
 * a confirmation for different arguments. Defence in depth: the API holds the key too (SECURITY.md §10.2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONFIRMATION_TTL_SEC = 120;

/** JSON with object keys sorted recursively, so equal values always produce equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

interface Claims {
  op: string;
  argsHash: string;
  actor: string;
  exp: number;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

function argsHash(key: Buffer, args: unknown): string {
  return createHmac('sha256', key).update('args\0').update(canonicalJson(args)).digest('base64url');
}

function sign(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update('confirm\0').update(payload).digest();
}

export function mintConfirmation(
  key: Buffer,
  input: { op: string; args: unknown; actor: string; nowSec?: number; ttlSec?: number },
): string {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const claims: Claims = {
    op: input.op,
    argsHash: argsHash(key, input.args),
    actor: input.actor,
    exp: now + (input.ttlSec ?? CONFIRMATION_TTL_SEC),
  };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${b64(sign(key, payload))}`;
}

export type ConfirmationCheck = { ok: true } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' };

export function verifyConfirmation(
  key: Buffer,
  token: string,
  expected: { op: string; args: unknown; actor: string; nowSec?: number },
): ConfirmationCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts;
  const want = sign(key, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature' };
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const now = expected.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) return { ok: false, reason: 'expired' };
  if (claims.op !== expected.op || claims.actor !== expected.actor || claims.argsHash !== argsHash(key, expected.args)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}
