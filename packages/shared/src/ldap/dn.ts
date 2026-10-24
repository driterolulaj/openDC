// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Distinguished names (RFC 4514): parsing, building, AD-style normalisation and scope checks.
 * RBAC scope checks (SECURITY.md §5) compare normalised RDN sequences, never raw strings.
 */
import { assertAttributeName, escapeDnValue } from './escape.ts';

export interface Ava {
  /** Attribute type as written (descr or OID). */
  type: string;
  /** Unescaped value. For `#hex` values this is the hex string and `hex` is true. */
  value: string;
  hex?: true;
}

/** One RDN; multi-valued RDNs (`cn=a+uid=b`) have more than one AVA. */
export type Rdn = Ava[];

declare const dnBrand: unique symbol;
/** A DN string that came out of `formatDn`/`dn`/the directory, i.e. correctly escaped. */
export type Dn = string & { readonly [dnBrand]: true };

export class DnSyntaxError extends Error {
  constructor(input: string, pos: number, what: string) {
    super(`Invalid DN at position ${String(pos)} (${what}): ${input}`);
    this.name = 'DnSyntaxError';
  }
}

const HEX = /^[0-9a-fA-F]{2}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function parseDn(input: string): Rdn[] {
  const rdns: Rdn[] = [];
  if (input.trim() === '') return rdns;
  let i = 0;
  const n = input.length;
  const skipSpaces = (): void => {
    while (i < n && input[i] === ' ') i++;
  };

  let rdn: Rdn = [];
  for (;;) {
    skipSpaces();
    // attribute type
    const typeStart = i;
    while (i < n && /[A-Za-z0-9.;-]/.test(input[i] ?? '')) i++;
    const type = input.slice(typeStart, i);
    if (type === '') throw new DnSyntaxError(input, i, 'attribute type expected');
    try {
      assertAttributeName(type);
    } catch {
      throw new DnSyntaxError(input, typeStart, 'bad attribute type');
    }
    skipSpaces();
    if (input[i] !== '=') throw new DnSyntaxError(input, i, '"=" expected');
    i++;
    skipSpaces();

    // attribute value
    let value = '';
    let hex = false;
    if (input[i] === '#') {
      const start = ++i;
      while (i < n && /[0-9a-fA-F]/.test(input[i] ?? '')) i++;
      value = input.slice(start, i);
      if (value.length === 0 || value.length % 2 !== 0) throw new DnSyntaxError(input, start, 'bad hex string');
      hex = true;
    } else {
      const bytes: number[] = [];
      let lastSignificant = 0; // length of `bytes` up to the last char that is not an unescaped trailing space
      const pushText = (s: string): void => {
        for (const b of new TextEncoder().encode(s)) bytes.push(b);
      };
      while (i < n) {
        const c = input[i] ?? '';
        if (c === ',' || c === '+' || c === ';') break;
        if (c === '\\') {
          const pair = input.slice(i + 1, i + 3);
          if (HEX.test(pair)) {
            bytes.push(parseInt(pair, 16));
            i += 3;
          } else if (i + 1 < n) {
            pushText(input[i + 1] ?? '');
            i += 2;
          } else {
            throw new DnSyntaxError(input, i, 'dangling backslash');
          }
          lastSignificant = bytes.length;
          continue;
        }
        // RFC 4514 allows an unescaped "=" inside a value; '"', '<' and '>' must be escaped.
        if (c === '"' || c === '<' || c === '>') throw new DnSyntaxError(input, i, `unescaped ${c}`);
        // Advance by code point, not UTF-16 unit, so astral characters are not split into surrogates.
        const ch = String.fromCodePoint(input.codePointAt(i) ?? 0);
        pushText(ch);
        i += ch.length;
        if (ch !== ' ') lastSignificant = bytes.length;
      }
      try {
        value = decoder.decode(Uint8Array.from(bytes.slice(0, lastSignificant)));
      } catch {
        throw new DnSyntaxError(input, i, 'invalid UTF-8 in escaped value');
      }
    }
    rdn.push(hex ? { type, value, hex: true } : { type, value });

    if (i >= n) {
      rdns.push(rdn);
      return rdns;
    }
    const sep = input[i];
    i++;
    if (sep === '+') continue;
    rdns.push(rdn);
    rdn = [];
    if (i >= n) throw new DnSyntaxError(input, i, 'RDN expected after separator');
  }
}

export function formatAva(ava: Ava): string {
  return `${ava.type}=${ava.hex ? '#' + ava.value : escapeDnValue(ava.value)}`;
}

export function formatDn(rdns: readonly Rdn[]): Dn {
  return rdns.map((r) => r.map(formatAva).join('+')).join(',') as Dn;
}

/** Build a DN from (type, value) pairs, leaf first. Values are escaped. */
export function buildDn(...parts: readonly (readonly [type: string, value: string])[]): Dn {
  return formatDn(parts.map(([type, value]) => [{ type: assertAttributeName(type), value }]));
}

/** `child(parent, 'CN', name)`: a direct child of an existing DN. */
export function childDn(parent: Dn | string, type: string, value: string): Dn {
  const p = parseDn(parent);
  return formatDn([[{ type: assertAttributeName(type), value }], ...p]);
}

/** Accept a DN string from the directory or config after validating its syntax. */
export function asDn(text: string): Dn {
  return formatDn(parseDn(text));
}

/**
 * AD-style normalisation: attribute types and values are compared case-insensitively (AD's DN values use
 * case-insensitive matching), Unicode NFC, multi-valued RDNs in a stable order.
 */
export function normalizeRdns(rdns: readonly Rdn[]): string[] {
  return rdns.map((r) =>
    r
      .map((a) => `${a.type.toLowerCase()}=${a.hex ? '#' + a.value.toLowerCase() : a.value.normalize('NFC').toLowerCase()}`)
      .sort()
      .join('+'),
  );
}

export function normalizeDn(text: string): string {
  return normalizeRdns(parseDn(text)).join(',');
}

export function dnEquals(a: string, b: string): boolean {
  return normalizeDn(a) === normalizeDn(b);
}

/** True when `target` equals `scope` or lies below it. */
export function isWithin(target: string, scope: string): boolean {
  const t = normalizeRdns(parseDn(target));
  const s = normalizeRdns(parseDn(scope));
  if (s.length > t.length) return false;
  const offset = t.length - s.length;
  return s.every((r, i) => t[offset + i] === r);
}

/** The parent DN, or null at the root. */
export function parentDn(text: string): Dn | null {
  const rdns = parseDn(text);
  return rdns.length <= 1 ? null : formatDn(rdns.slice(1));
}

/** "DC=example,DC=com" -> "example.com" (only for DNs that consist of DC components). */
export function domainFromDn(text: string): string {
  const rdns = parseDn(text);
  const dcs = rdns.filter((r) => r.length === 1 && r[0]?.type.toLowerCase() === 'dc').map((r) => r[0]?.value ?? '');
  return dcs.join('.');
}

/** "example.com" -> "DC=example,DC=com" */
export function dnFromDomain(domain: string): Dn {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length === 0) throw new TypeError(`Invalid DNS domain: ${domain}`);
  return buildDn(...labels.map((l) => ['DC', l] as const));
}
