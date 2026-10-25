// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionSection, isDnsName, leafSans, renewalDue, safeCn, serialHex } from './index.ts';

const G = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

test('SANs per profile: DNS names validated, node certificates carry the node URN', () => {
  assert.deepEqual(leafSans({ profile: 'node', fqdn: 'DC1.example.test', nodeGuid: G }), [
    'DNS:dc1.example.test',
    `URI:urn:opendc:node:${G}`,
  ]);
  assert.deepEqual(
    leafSans({ profile: 'ldaps', fqdn: 'dc1.example.test', extraNames: ['example.test', 'dc1.example.test'] }),
    ['DNS:dc1.example.test', 'DNS:example.test'],
  );
  assert.throws(() => leafSans({ profile: 'node', fqdn: 'dc1.example.test' }), /node GUID/);
  assert.throws(() => leafSans({ profile: 'web', fqdn: 'bad name' }), /not a DNS name/);
  assert.throws(() => leafSans({ profile: 'web', fqdn: 'x.test', extraNames: ['a/b'] }), /not a DNS name/);
  assert.ok(isDnsName('a-b.c'));
  assert.ok(!isDnsName('-a.c'));
});

test('extension sections: CA constraints, key usages, SANs, CRL distribution point', () => {
  const root = extensionSection({ profile: 'root' });
  assert.match(root, /CA:TRUE, pathlen:1/);
  assert.doesNotMatch(root, /authorityKeyIdentifier/);
  assert.match(extensionSection({ profile: 'issuer' }), /CA:TRUE, pathlen:0/);
  const node = extensionSection({
    profile: 'node',
    sans: ['DNS:dc1.x', `URI:urn:opendc:node:${G}`],
    crlUrl: 'https://dc1.x:8443/pki/crl/issuer-dc1.crl',
  });
  assert.match(node, /extendedKeyUsage = serverAuth, clientAuth/);
  assert.match(node, /subjectAltName = DNS:dc1.x, URI:urn:opendc:node:/);
  assert.match(node, /crlDistributionPoints = URI:https:\/\/dc1.x:8443\/pki\/crl\/issuer-dc1.crl/);
  assert.match(extensionSection({ profile: 'web' }), /extendedKeyUsage = serverAuth\n/);
  assert.match(extensionSection({ profile: 'ldaps' }), /CA:FALSE/);
  assert.throws(() => extensionSection({ profile: 'web', sans: ['DNS:a,b'] }), /bad SAN/);
  assert.throws(() => extensionSection({ profile: 'web', sans: ['IP:1.2.3.4'] }), /bad SAN/);
  assert.throws(() => extensionSection({ profile: 'web', crlUrl: 'file:///etc/passwd' }), /bad CRL URL/);
});

test('renewal at 2/3 of the lifetime (time-shifted)', () => {
  const nb = new Date('2026-01-01T00:00:00Z');
  const na = new Date('2027-01-01T00:00:00Z'); // 365 days
  assert.equal(renewalDue(nb, na, new Date('2026-08-31T00:00:00Z')), false);
  assert.equal(renewalDue(nb, na, new Date('2026-09-02T00:00:00Z')), true);
  assert.equal(renewalDue(nb, na, new Date('2026-06-01T00:00:00Z'), 0.25), true);
});

test('serials are positive 128-bit values; subject names are made safe', () => {
  assert.equal(serialHex(new Uint8Array(16).fill(0xff)).slice(0, 2), '7F');
  assert.equal(serialHex(new Uint8Array(16)).slice(0, 2), '01');
  assert.equal(serialHex(new Uint8Array(16).fill(0xab)).length, 32);
  assert.throws(() => serialHex(new Uint8Array(8)), /16 random bytes/);
  assert.equal(safeCn('OpenDC Issuing CA dc1/../CN=evil'), 'OpenDC Issuing CA dc1..CNevil');
  assert.throws(() => safeCn('///'), /empty subject/);
});
