// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultNetbios,
  dnsDomainIssue,
  fqdnSchema,
  hostLabelIssue,
  netbiosIssue,
  passwordIssue,
  provisionArgs,
  joinArgs,
  confirmationPhrase,
} from './index.ts';

test('host labels are NetBIOS-safe DNS labels', () => {
  assert.equal(hostLabelIssue('dc1'), null);
  assert.equal(hostLabelIssue('a-very-long-name'), 'too-long'); // 16 characters
  assert.equal(hostLabelIssue('dc_1'), 'invalid-chars');
  assert.equal(hostLabelIssue('-dc'), 'invalid-chars');
  assert.equal(hostLabelIssue('12345'), 'numeric');
  assert.equal(hostLabelIssue('localhost'), 'reserved');
  assert.equal(hostLabelIssue(''), 'empty');
});

test('DNS domains need two labels and are not .local', () => {
  assert.equal(dnsDomainIssue('ad.example.com'), null);
  assert.equal(dnsDomainIssue('Example.COM.'), null);
  assert.equal(dnsDomainIssue('example'), 'single-label');
  assert.equal(dnsDomainIssue('corp.local'), 'mdns-local');
  assert.equal(dnsDomainIssue('bad_label.com'), 'invalid-chars');
  assert.equal(dnsDomainIssue('example.123'), 'numeric');
});

test('NetBIOS names: 15 characters, no dot, not the host name', () => {
  assert.equal(netbiosIssue('EXAMPLE'), null);
  assert.equal(netbiosIssue('EX.AMPLE'), 'netbios-dot');
  assert.equal(netbiosIssue('ABCDEFGHIJKLMNOP'), 'too-long');
  assert.equal(netbiosIssue('DC1', 'dc1'), 'netbios-equals-host');
  assert.equal(defaultNetbios('standard.opendc.test'), 'STANDARD');
  assert.equal(defaultNetbios('a-very-long-company-name.example'), 'A-VERY-LONG-COM');
});

test('password complexity matches the AD default', () => {
  assert.equal(passwordIssue('Short1!'), 'too-short');
  assert.equal(passwordIssue('alllowercase1'), 'complexity');
  assert.equal(passwordIssue('Lower-and-Upper'), null);
  assert.equal(passwordIssue('Xadministrator1!'), 'contains-name');
  assert.equal(passwordIssue('x'.repeat(300)), 'too-long');
});

test('setup argument schemas normalise and default', () => {
  const p = provisionArgs.parse({
    fqdn: 'DC1.Example.COM',
    hostIp: '10.0.0.11',
    domain: 'Example.COM',
    netbiosDomain: 'example',
    adminPassword: 'Secret-Pass1',
    dnsForwarders: ['1.1.1.1'],
  });
  assert.equal(p.fqdn, 'dc1.example.com');
  assert.equal(p.domain, 'example.com');
  assert.equal(p.netbiosDomain, 'EXAMPLE');
  assert.equal(p.functionalLevel, '2008_R2');
  assert.equal(p.baseSchema, '2016');
  assert.equal(p.idBase, 100_000);
  assert.ok(!provisionArgs.safeParse({ ...p, adminPassword: 'weak' }).success);
  assert.ok(!provisionArgs.safeParse({ ...p, extra: 1 }).success, 'strict');
  assert.ok(!provisionArgs.safeParse({ ...p, hostIp: '10.0.0.300' }).success);
  assert.ok(!fqdnSchema.safeParse('a-very-long-hostname.example.com').success);
  const j = joinArgs.parse({
    fqdn: 'dc2.example.com',
    hostIp: '10.0.0.12',
    domain: 'example.com',
    dnsForwarders: [],
    dcHost: '10.0.0.11',
    username: 'Administrator',
    password: 'x',
  });
  assert.equal(j.siteName, 'Default-First-Site-Name');
  assert.equal(confirmationPhrase({ domain: 'Example.COM' }), 'example.com');
});
