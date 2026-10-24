// SPDX-License-Identifier: AGPL-3.0-only
/**
 * LDAP filter builders. A filter is a branded object, so the type system tells apart "already a safe
 * filter" from "a string that still needs escaping".
 */
import { assertAttributeName, escapeFilterBytes, escapeFilterValue } from './escape.ts';

declare const filterBrand: unique symbol;

export interface LdapFilter {
  readonly [filterBrand]: true;
  readonly text: string;
  toString(): string;
}

function make(text: string): LdapFilter {
  return { text, toString: () => text } as LdapFilter;
}

export function isLdapFilter(v: unknown): v is LdapFilter {
  return typeof v === 'object' && v !== null && typeof (v as { text?: unknown }).text === 'string' && 'toString' in v;
}

type Value = string | number | bigint | Uint8Array;

function encodeValue(v: Value): string {
  if (v instanceof Uint8Array) return escapeFilterBytes(v);
  return escapeFilterValue(String(v));
}

export const eq = (attr: string, value: Value): LdapFilter =>
  make(`(${assertAttributeName(attr)}=${encodeValue(value)})`);
export const ge = (attr: string, value: Value): LdapFilter =>
  make(`(${assertAttributeName(attr)}>=${encodeValue(value)})`);
export const le = (attr: string, value: Value): LdapFilter =>
  make(`(${assertAttributeName(attr)}<=${encodeValue(value)})`);
export const present = (attr: string): LdapFilter => make(`(${assertAttributeName(attr)}=*)`);

/** Substring match; every part is escaped, so `*` in user input matches a literal asterisk. */
export function substring(attr: string, parts: { initial?: string; any?: string[]; final?: string }): LdapFilter {
  const segs = [parts.initial ?? '', ...(parts.any ?? []), parts.final ?? ''].map(escapeFilterValue);
  if (segs.length === 2 && segs[0] === '' && segs[1] === '') return present(attr);
  return make(`(${assertAttributeName(attr)}=${segs.join('*')})`);
}

/** Case-insensitive "contains" as used by console search boxes. */
export const contains = (attr: string, text: string): LdapFilter => substring(attr, { any: [text] });

const OID_BIT_AND = '1.2.840.113556.1.4.803';
const OID_BIT_OR = '1.2.840.113556.1.4.804';
const OID_IN_CHAIN = '1.2.840.113556.1.4.1941';

/** `(attr:1.2.840.113556.1.4.803:=mask)`: all bits of mask set (e.g. userAccountControl flags). */
export const bitAnd = (attr: string, mask: number): LdapFilter => {
  if (!Number.isSafeInteger(mask) || mask < 0) throw new TypeError(`Invalid bit mask: ${String(mask)}`);
  return make(`(${assertAttributeName(attr)}:${OID_BIT_AND}:=${String(mask)})`);
};
export const bitOr = (attr: string, mask: number): LdapFilter => {
  if (!Number.isSafeInteger(mask) || mask < 0) throw new TypeError(`Invalid bit mask: ${String(mask)}`);
  return make(`(${assertAttributeName(attr)}:${OID_BIT_OR}:=${String(mask)})`);
};
/** Transitive membership: `(memberOf:1.2.840.113556.1.4.1941:=<dn>)`. */
export const inChain = (attr: string, dn: string): LdapFilter =>
  make(`(${assertAttributeName(attr)}:${OID_IN_CHAIN}:=${escapeFilterValue(dn)})`);

function compose(op: '&' | '|', filters: LdapFilter[]): LdapFilter {
  if (filters.length === 0) throw new TypeError(`Empty ${op === '&' ? 'and' : 'or'}() filter`);
  if (filters.length === 1 && filters[0]) return filters[0];
  return make(`(${op}${filters.map((f) => f.text).join('')})`);
}

export const and = (...filters: LdapFilter[]): LdapFilter => compose('&', filters);
export const or = (...filters: LdapFilter[]): LdapFilter => compose('|', filters);
export const not = (f: LdapFilter): LdapFilter => make(`(!${f.text})`);

/**
 * Tagged template for filters written in code. The literal parts are trusted (they are source code);
 * interpolations are escaped, except LdapFilter values, which are inserted as sub-filters.
 *
 *   filter`(&(objectClass=user)(sAMAccountName=${name}))`
 */
export function filter(strings: TemplateStringsArray, ...values: (Value | LdapFilter)[]): LdapFilter {
  let text = strings[0] ?? '';
  values.forEach((v, i) => {
    text += (isLdapFilter(v) ? v.text : encodeValue(v)) + (strings[i + 1] ?? '');
  });
  assertBalanced(text);
  return make(text);
}

/** A static filter from configuration or a manifest. It must be balanced and parenthesised. */
export function staticFilter(text: string): LdapFilter {
  if (!text.startsWith('(') || !text.endsWith(')')) throw new TypeError(`Filter must be parenthesised: ${text}`);
  assertBalanced(text);
  return make(text);
}

function assertBalanced(text: string): void {
  parseFilter(text);
}

// ---------------------------------------------------------------------------------------------------------
// RFC 4515 parser. The LDAP client never hands filter *strings* to the library: ldapts decodes `\xx` escapes
// as single Latin-1 characters and re-encodes them as UTF-8, which corrupts escaped non-ASCII text and binary
// values (objectGUID). Instead every filter is parsed here into a byte-exact tree, and the client converts
// the tree to library filter objects (packages/shared/src/ldap/client.ts).
// ---------------------------------------------------------------------------------------------------------

export type FilterNode =
  | { type: 'and' | 'or'; children: FilterNode[] }
  | { type: 'not'; child: FilterNode }
  | { type: 'eq' | 'ge' | 'le' | 'approx'; attr: string; value: Uint8Array }
  | { type: 'present'; attr: string }
  | { type: 'substring'; attr: string; initial?: Uint8Array; any: Uint8Array[]; final?: Uint8Array }
  | { type: 'ext'; attr?: string; rule?: string; dnAttributes: boolean; value: Uint8Array };

export class FilterSyntaxError extends TypeError {
  constructor(text: string, pos: number, what: string) {
    super(`Invalid LDAP filter at position ${String(pos)} (${what}): ${text}`);
    this.name = 'FilterSyntaxError';
  }
}

const utf8 = new TextEncoder();
const ATTR_CHARS = /[A-Za-z0-9.;-]/;

export function parseFilter(text: string): FilterNode {
  let i = 0;
  const fail = (what: string): never => {
    throw new FilterSyntaxError(text, i, what);
  };

  const parseOne = (): FilterNode => {
    if (text[i] !== '(') fail('"(" expected');
    i++;
    let node: FilterNode;
    const c = text[i];
    if (c === '&' || c === '|') {
      i++;
      const children: FilterNode[] = [];
      while (text[i] === '(') children.push(parseOne());
      if (children.length === 0) fail('empty and/or');
      node = { type: c === '&' ? 'and' : 'or', children };
    } else if (c === '!') {
      i++;
      node = { type: 'not', child: parseOne() };
    } else {
      node = parseItem();
    }
    if (text[i] !== ')') fail('")" expected');
    i++;
    return node;
  };

  /** Reads an assertion value up to ")" (or "*" when `stopAtStar`), decoding escapes as raw bytes. */
  const readValue = (stopAtStar: boolean): Uint8Array => {
    const bytes: number[] = [];
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === ')' || (stopAtStar && ch === '*')) break;
      if (ch === '(' || (!stopAtStar && ch === '*')) fail(`unescaped ${ch}`);
      if (ch === '\\') {
        const pair = text.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(pair)) fail('bad escape');
        bytes.push(parseInt(pair, 16));
        i += 3;
        continue;
      }
      const cp = text.codePointAt(i) ?? 0;
      const s = String.fromCodePoint(cp);
      for (const b of utf8.encode(s)) bytes.push(b);
      i += s.length;
    }
    return Uint8Array.from(bytes);
  };

  const readAttr = (): string => {
    const start = i;
    while (i < text.length && ATTR_CHARS.test(text[i] ?? '')) i++;
    return text.slice(start, i);
  };

  const parseItem = (): FilterNode => {
    const attr = readAttr();
    const op = text[i];
    if (op === ':') {
      // extensible: attr? [":dn"] [":" rule] ":=" value
      let dnAttributes = false;
      let rule: string | undefined;
      while (text[i] === ':' && text[i + 1] !== '=') {
        i++;
        const word = readAttr();
        if (word.toLowerCase() === 'dn') dnAttributes = true;
        else rule = word;
      }
      if (text.slice(i, i + 2) !== ':=') fail('":=" expected');
      i += 2;
      if (!attr && !rule) fail('extensible match needs an attribute or a rule');
      return {
        type: 'ext',
        ...(attr ? { attr: assertAttrName(attr) } : {}),
        ...(rule ? { rule } : {}),
        dnAttributes,
        value: readValue(false),
      };
    }
    assertAttrName(attr);
    if (text.slice(i, i + 2) === '>=') {
      i += 2;
      return { type: 'ge', attr, value: readValue(false) };
    }
    if (text.slice(i, i + 2) === '<=') {
      i += 2;
      return { type: 'le', attr, value: readValue(false) };
    }
    if (text.slice(i, i + 2) === '~=') {
      i += 2;
      return { type: 'approx', attr, value: readValue(false) };
    }
    if (op !== '=') fail('filter type expected');
    i++;
    if (text.slice(i, i + 2) === '*)') {
      i++;
      return { type: 'present', attr };
    }
    const parts: Uint8Array[] = [readValue(true)];
    while (text[i] === '*') {
      i++;
      parts.push(readValue(true));
    }
    if (parts.length === 1) return { type: 'eq', attr, value: parts[0] ?? new Uint8Array() };
    const initial = parts[0];
    const final = parts.at(-1);
    const any = parts.slice(1, -1);
    if (any.some((p) => p.length === 0)) fail('empty substring component');
    return {
      type: 'substring',
      attr,
      ...(initial && initial.length > 0 ? { initial } : {}),
      any,
      ...(final && final.length > 0 ? { final } : {}),
    };
  };

  const assertAttrName = (a: string): string => {
    try {
      return assertAttributeName(a);
    } catch {
      return fail('attribute description expected');
    }
  };

  const root = parseOne();
  if (i !== text.length) fail('trailing characters');
  return root;
}

/** Parse tree of a built filter. */
export function filterTree(f: LdapFilter): FilterNode {
  return parseFilter(f.text);
}
