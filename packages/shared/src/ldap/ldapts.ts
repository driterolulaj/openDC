// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Converts our byte-exact filter tree (filter.ts) into ldapts filter objects, so the library never parses a
 * filter string. Equality values go over the wire as raw bytes; the other assertion types take strings in
 * ldapts, so their bytes must be valid UTF-8 (true for every text attribute).
 */
import {
  AndFilter,
  ApproximateFilter,
  EqualityFilter,
  ExtensibleFilter,
  GreaterThanEqualsFilter,
  LessThanEqualsFilter,
  NotFilter,
  OrFilter,
  PresenceFilter,
  SubstringFilter,
  type Filter,
} from 'ldapts';
import { filterTree, type FilterNode, type LdapFilter } from './filter.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true });

function text(bytes: Uint8Array, attr: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new TypeError(`Filter value for ${attr} is not valid UTF-8; only equality matches can carry binary values`);
  }
}

export function toLdaptsFilter(node: FilterNode): Filter {
  switch (node.type) {
    case 'and':
      return new AndFilter({ filters: node.children.map(toLdaptsFilter) });
    case 'or':
      return new OrFilter({ filters: node.children.map(toLdaptsFilter) });
    case 'not':
      return new NotFilter({ filter: toLdaptsFilter(node.child) });
    case 'eq':
      return new EqualityFilter({ attribute: node.attr, value: Buffer.from(node.value) });
    case 'ge':
      return new GreaterThanEqualsFilter({ attribute: node.attr, value: text(node.value, node.attr) });
    case 'le':
      return new LessThanEqualsFilter({ attribute: node.attr, value: text(node.value, node.attr) });
    case 'approx':
      return new ApproximateFilter({ attribute: node.attr, value: text(node.value, node.attr) });
    case 'present':
      return new PresenceFilter({ attribute: node.attr });
    case 'substring':
      return new SubstringFilter({
        attribute: node.attr,
        ...(node.initial ? { initial: text(node.initial, node.attr) } : {}),
        any: node.any.map((a) => text(a, node.attr)),
        ...(node.final ? { final: text(node.final, node.attr) } : {}),
      });
    case 'ext':
      return new ExtensibleFilter({
        ...(node.attr ? { matchType: node.attr } : {}),
        ...(node.rule ? { rule: node.rule } : {}),
        dnAttributes: node.dnAttributes,
        value: text(node.value, node.attr ?? node.rule ?? 'extensible'),
      });
  }
}

/** The ldapts filter for one of our filters. */
export function ldaptsFilter(f: LdapFilter): Filter {
  return toLdaptsFilter(filterTree(f));
}
