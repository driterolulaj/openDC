// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RFC 4515 (filter) and RFC 4514 (DN) value escaping. These are the only functions allowed to put
 * untrusted text into a filter or DN (CLAUDE.md hard rule 7; lint rule opendc/no-raw-ldap).
 */

const encoder = new TextEncoder();
const hex2 = (b: number): string => '\\' + b.toString(16).padStart(2, '0');

/**
 * Escape a value for use inside a filter assertion. Escapes the RFC 4515 specials `* ( ) \ NUL`, every
 * control character, and every non-ASCII character as its UTF-8 bytes, so the result is pure ASCII.
 */
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x2a || cp === 0x28 || cp === 0x29 || cp === 0x5c || cp < 0x20 || cp === 0x7f) {
      out += hex2(cp);
    } else if (cp > 0x7f) {
      for (const b of encoder.encode(ch)) out += hex2(b);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape raw bytes (objectGUID, objectSid) for a filter: every byte as \xx. */
export function escapeFilterBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += hex2(b);
  return out;
}

const DN_SPECIALS = new Set(['"', '+', ',', ';', '<', '>', '\\', '=']);

/**
 * Escape an attribute value for use in a DN (RFC 4514 §2.4). Also escapes `=` (which AD always escapes)
 * and control characters. Non-ASCII text stays as UTF-8, which AD and Samba accept.
 */
export function escapeDnValue(value: string): string {
  if (value === '') return '';
  const chars = Array.from(value);
  let out = '';
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0) ?? 0;
    const first = i === 0;
    const last = i === chars.length - 1;
    if (DN_SPECIALS.has(ch)) out += '\\' + ch;
    else if (cp < 0x20 || cp === 0x7f) out += hex2(cp);
    else if ((first && (ch === ' ' || ch === '#')) || (last && ch === ' ')) out += '\\' + ch;
    else out += ch;
  });
  return out;
}

/** Attribute descriptions: a name (descr) or numeric OID, optionally with ;options (RFC 4512 §2.5). */
const ATTR_RE = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)(?:;[A-Za-z0-9-]+)*$/;

export function isValidAttributeName(name: string): boolean {
  return ATTR_RE.test(name);
}

export function assertAttributeName(name: string): string {
  if (!ATTR_RE.test(name)) throw new TypeError(`Invalid LDAP attribute description: ${JSON.stringify(name)}`);
  return name;
}
