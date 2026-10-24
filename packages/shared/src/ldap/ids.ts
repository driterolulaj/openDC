// SPDX-License-Identifier: AGPL-3.0-only
/** objectGUID / objectSid conversions and the `<GUID=...>` / `<SID=...>` base-DN forms AD accepts. */
import { escapeFilterBytes } from './escape.ts';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID_RE = /^S-1-\d+(?:-\d+)+$/;

export function isGuid(text: string): boolean {
  return GUID_RE.test(text);
}

export function isSid(text: string): boolean {
  return SID_RE.test(text);
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** objectGUID bytes (mixed-endian, as AD returns them) to the canonical string form. */
export function guidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new TypeError(`objectGUID must be 16 bytes, got ${String(bytes.length)}`);
  const b = bytes;
  const le = (from: number, len: number): string => hex(b.slice(from, from + len).reverse());
  return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${hex(b.slice(8, 10))}-${hex(b.slice(10, 16))}`;
}

export function guidToBytes(guid: string): Uint8Array {
  if (!GUID_RE.test(guid)) throw new TypeError(`Not a GUID: ${guid}`);
  const h = guid.replaceAll('-', '');
  const bytes = Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

/** Base DN that addresses an object by GUID, independent of renames and moves. */
export function guidBase(guid: string): string {
  if (!GUID_RE.test(guid)) throw new TypeError(`Not a GUID: ${guid}`);
  return `<GUID=${guid.toLowerCase()}>`;
}

export function sidBase(sid: string): string {
  if (!SID_RE.test(sid)) throw new TypeError(`Not a SID: ${sid}`);
  return `<SID=${sid}>`;
}

/** Filter value for matching objectGUID: every byte escaped. */
export function guidFilterValue(guid: string): string {
  return escapeFilterBytes(guidToBytes(guid));
}

/** Binary objectSid to "S-1-5-21-..." */
export function sidFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new TypeError('objectSid too short');
  const revision = bytes[0] ?? 0;
  const count = bytes[1] ?? 0;
  if (bytes.length !== 8 + count * 4) throw new TypeError('objectSid length does not match its sub-authority count');
  let authority = 0n;
  for (let i = 2; i < 8; i++) authority = (authority << 8n) | BigInt(bytes[i] ?? 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const subs: string[] = [];
  for (let i = 0; i < count; i++) subs.push(String(view.getUint32(8 + i * 4, true)));
  return `S-${String(revision)}-${authority.toString()}${subs.map((s) => '-' + s).join('')}`;
}

export function sidToBytes(sid: string): Uint8Array {
  if (!SID_RE.test(sid)) throw new TypeError(`Not a SID: ${sid}`);
  const [, rev, auth, ...subs] = sid.split('-');
  const bytes = new Uint8Array(8 + subs.length * 4);
  bytes[0] = Number(rev);
  bytes[1] = subs.length;
  let a = BigInt(auth ?? '0');
  for (let i = 7; i >= 2; i--) {
    bytes[i] = Number(a & 0xffn);
    a >>= 8n;
  }
  const view = new DataView(bytes.buffer);
  subs.forEach((s, i) => view.setUint32(8 + i * 4, Number(s), true));
  return bytes;
}

/** The relative identifier (last sub-authority) of a SID. */
export function ridOf(sid: string): number {
  const last = sid.split('-').at(-1);
  if (!isSid(sid) || last === undefined) throw new TypeError(`Not a SID: ${sid}`);
  return Number(last);
}

/** Well-known RIDs used by the RBAC built-ins and the tier-0 guard. */
export const WELL_KNOWN_RIDS = {
  administrator: 500,
  krbtgt: 502,
  domainAdmins: 512,
  domainControllers: 516,
  schemaAdmins: 518,
  enterpriseAdmins: 519,
  groupPolicyCreatorOwners: 520,
  readOnlyDomainControllers: 521,
} as const;

/** Builtin protected groups (S-1-5-32-*), see AdminSDHolder. */
export const PROTECTED_BUILTIN_SIDS = [
  'S-1-5-32-544', // Administrators
  'S-1-5-32-548', // Account Operators
  'S-1-5-32-549', // Server Operators
  'S-1-5-32-550', // Print Operators
  'S-1-5-32-551', // Backup Operators
  'S-1-5-32-552', // Replicators
] as const;
