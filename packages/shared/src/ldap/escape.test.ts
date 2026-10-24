// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterParser } from 'ldapts';
import {
  assertAttributeName,
  escapeDnValue,
  escapeFilterBytes,
  escapeFilterValue,
  isValidAttributeName,
} from './escape.ts';
import { parseDn } from './dn.ts';
import { eq, parseFilter } from './filter.ts';
import { randomStrings } from './testing.ts';

test('escapeFilterValue: RFC 4515 §4 examples and specials', () => {
  const table: [string, string][] = [
    ['Parens R Us (for all your parenthetical needs)', 'Parens R Us \\28for all your parenthetical needs\\29'],
    ['*', '\\2a'],
    ['C:\\MyFile', 'C:\\5cMyFile'],
    ['\u0000\u0000\u0000\u0004', '\\00\\00\\00\\04'],
    ['Lučić', 'Lu\\c4\\8di\\c4\\87'],
    ['a)(objectClass=*', 'a\\29\\28objectClass=\\2a'],
    ['tab\there', 'tab\\09here'],
    ['del\u007f', 'del\\7f'],
    ['emoji 😀', 'emoji \\f0\\9f\\98\\80'],
    ['', ''],
    ['plain-text_ok.123', 'plain-text_ok.123'],
  ];
  for (const [input, expected] of table) assert.equal(escapeFilterValue(input), expected, JSON.stringify(input));
});

test('escapeFilterBytes escapes every byte', () => {
  assert.equal(escapeFilterBytes(Uint8Array.from([0, 0x2a, 0xff, 0x41])), '\\00\\2a\\ff\\41');
});

test('escapeFilterValue output is ASCII without unescaped specials (property)', () => {
  for (const s of randomStrings(2000, 1)) {
    const e = escapeFilterValue(s);
    assert.match(e, /^[\x20-\x7e]*$/, JSON.stringify(s));
    assert.doesNotMatch(e.replace(/\\[0-9a-f]{2}/g, ''), /[()*\\]/, JSON.stringify(s));
  }
});

test('escaped values round-trip byte-exactly through our filter parser (property)', () => {
  for (const s of randomStrings(2000, 2)) {
    const node = parseFilter(eq('cn', s).text);
    assert.equal(node.type, 'eq');
    if (node.type === 'eq') assert.deepEqual(Buffer.from(node.value), Buffer.from(s, 'utf8'), JSON.stringify(s));
  }
});

test('ASCII values also round-trip through the ldapts parser (independent oracle)', () => {
  for (const s of randomStrings(2000, 3, { asciiOnly: true })) {
    const parsed = FilterParser.parseString(eq('cn', s).text) as unknown as { value: string };
    assert.equal(parsed.value, s, JSON.stringify(s));
  }
});

test('escapeDnValue: RFC 4514 §4 examples, leading/trailing rules, AD "="', () => {
  const table: [string, string][] = [
    ['Sue, Grabbit and Runn', 'Sue\\, Grabbit and Runn'],
    ['Before\rAfter', 'Before\\0dAfter'],
    ['#hash', '\\#hash'],
    ['in#side', 'in#side'],
    [' lead', '\\ lead'],
    ['trail ', 'trail\\ '],
    [' ', '\\ '],
    ['a+b;c<d>e"f\\g=h', 'a\\+b\\;c\\<d\\>e\\"f\\\\g\\=h'],
    ['Müller', 'Müller'],
    ['', ''],
  ];
  for (const [input, expected] of table) assert.equal(escapeDnValue(input), expected, JSON.stringify(input));
});

test('escaped DN values round-trip through parseDn (property)', () => {
  for (const s of randomStrings(2000, 4)) {
    const rdns = parseDn(`CN=${escapeDnValue(s)},DC=example,DC=com`);
    assert.equal(rdns.length, 3, JSON.stringify(s));
    assert.equal(rdns[0]?.[0]?.value, s, JSON.stringify(s));
  }
});

test('attribute names: descr, OID and options', () => {
  for (const ok of ['cn', 'sAMAccountName', 'msDS-Settings', '1.2.840.113556.1.4.221', 'userCertificate;binary']) {
    assert.ok(isValidAttributeName(ok), ok);
    assert.equal(assertAttributeName(ok), ok);
  }
  for (const bad of ['', '1cn', 'cn=x', 'c n', 'cn)', '-cn', '1.', 'cn;']) {
    assert.ok(!isValidAttributeName(bad), bad);
    assert.throws(() => assertAttributeName(bad), TypeError);
  }
});
