// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal LDIF (RFC 2849) for the agent's local sam.ldb access through the ldb tools: writing change records
 * (fed on stdin, so secrets never appear in argv) and reading `ldbsearch` output. Values are always written
 * base64-encoded unless they are plain safe strings, so no attribute value can inject LDIF syntax.
 */

export type LdifValue = string | Buffer;
export type LdifAttrs = Record<string, LdifValue | readonly LdifValue[]>;

const SAFE = /^[\x21-\x39\x3b\x3d-\x7e][\x20-\x7e]*$/;

function line(attr: string, v: LdifValue): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(attr)) throw new TypeError(`Invalid LDIF attribute name ${attr}`);
  if (typeof v === 'string' && SAFE.test(v) && !v.endsWith(' ')) return `${attr}: ${v}`;
  return `${attr}:: ${Buffer.from(v).toString('base64')}`;
}

function dnLine(dn: string): string {
  return line('dn', dn);
}

function values(v: LdifValue | readonly LdifValue[]): readonly LdifValue[] {
  return typeof v === 'string' || Buffer.isBuffer(v) ? [v] : v;
}

export function addRecord(dn: string, attrs: LdifAttrs): string {
  const out = [dnLine(dn), 'changetype: add'];
  for (const [k, v] of Object.entries(attrs)) for (const x of values(v)) out.push(line(k, x));
  return out.join('\n') + '\n\n';
}

export type Mod = { op: 'add' | 'replace' | 'delete'; attr: string; values?: readonly LdifValue[] };

export function modifyRecord(dn: string, mods: readonly Mod[]): string {
  const out = [dnLine(dn), 'changetype: modify'];
  for (const m of mods) {
    out.push(line(m.op, m.attr));
    for (const v of m.values ?? []) out.push(line(m.attr, v));
    out.push('-');
  }
  return out.join('\n') + '\n\n';
}

/** AD's unicodePwd encoding: the quoted password in UTF-16LE. */
export function unicodePwd(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

export interface LdifEntry {
  dn: string;
  attrs: Map<string, string[]>;
}

/** Parses ldbsearch output: records separated by blank lines, folded lines, `::` base64 values, `#` comments. */
export function parseLdif(text: string): LdifEntry[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n /g, '');
  const entries: LdifEntry[] = [];
  for (const block of unfolded.split(/\n{2,}/)) {
    let current: LdifEntry | null = null;
    for (const raw of block.split('\n')) {
      if (!raw || raw.startsWith('#')) continue;
      const m = /^([A-Za-z0-9;.-]+)(::?) ?(.*)$/.exec(raw);
      if (!m) continue;
      const attr = m[1] ?? '';
      const value = m[2] === '::' ? Buffer.from(m[3] ?? '', 'base64').toString('utf8') : (m[3] ?? '');
      if (attr.toLowerCase() === 'dn') {
        current = { dn: value, attrs: new Map() };
        entries.push(current);
        continue;
      }
      if (!current) continue;
      const key = attr.toLowerCase();
      const list = current.attrs.get(key) ?? [];
      list.push(value);
      current.attrs.set(key, list);
    }
  }
  return entries;
}

export function first(e: LdifEntry | null | undefined, attr: string): string | null {
  return e?.attrs.get(attr.toLowerCase())?.[0] ?? null;
}
