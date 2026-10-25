// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDnsRecord,
  expectedDcRecords,
  isDcRecordName,
  ownerName,
  recordData,
  recordName,
  dnsFqdn,
  sambaToolData,
  sameRecord,
} from './index.ts';

/** dnsRecord as Samba stores it: header (TTL big-endian), then the type's data. */
function blob(type: number, data: Buffer, o: { ttl?: number; ts?: number } = {}): Buffer {
  const h = Buffer.alloc(24);
  h.writeUInt16LE(data.length, 0);
  h.writeUInt16LE(type, 2);
  h.writeUInt8(5, 4);
  h.writeUInt8(0xf0, 5);
  h.writeUInt32LE(7, 8);
  h.writeUInt32BE(o.ttl ?? 900, 12);
  h.writeUInt32LE(o.ts ?? 0, 20);
  return Buffer.concat([h, data]);
}
function countName(name: string): Buffer {
  const labels = name.split('.');
  const body = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')])),
    Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([body.length, labels.length]), body]);
}
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

test('dnsRecord: every type, TTL, dynamic flag; tombstones and damaged values are null', () => {
  assert.deepEqual(decodeDnsRecord(blob(1, Buffer.from([10, 97, 10, 11]), { ttl: 3600 })), {
    type: 'A',
    address: '10.97.10.11',
    ttl: 3600,
    dynamic: false,
  });
  const v6 = Buffer.from('20010db8000000000000000000000001', 'hex');
  assert.equal((decodeDnsRecord(blob(28, v6)) as { address: string }).address, '2001:db8::1');
  const v6b = Buffer.from('fe800000000000000210000000000001', 'hex');
  assert.equal((decodeDnsRecord(blob(28, v6b)) as { address: string }).address, 'fe80::210:0:0:1');
  const v6c = Buffer.from('20010db8000100020003000400050006', 'hex');
  assert.equal((decodeDnsRecord(blob(28, v6c)) as { address: string }).address, '2001:db8:1:2:3:4:5:6');
  assert.deepEqual(decodeDnsRecord(blob(5, countName('dc1.example.test'), { ts: 3_700_000 })), {
    type: 'CNAME',
    target: 'dc1.example.test',
    ttl: 900,
    dynamic: true,
  });
  assert.equal((decodeDnsRecord(blob(2, countName('dc1.example.test'))) as { type: string }).type, 'NS');
  assert.equal(
    (decodeDnsRecord(blob(12, countName('pc.example.test'))) as { target: string }).target,
    'pc.example.test',
  );
  assert.deepEqual(decodeDnsRecord(blob(15, Buffer.concat([u16(10), countName('mail.example.test')]))), {
    type: 'MX',
    preference: 10,
    exchange: 'mail.example.test',
    ttl: 900,
    dynamic: false,
  });
  assert.deepEqual(
    decodeDnsRecord(blob(33, Buffer.concat([u16(0), u16(100), u16(389), countName('dc1.example.test')]))),
    { type: 'SRV', priority: 0, weight: 100, port: 389, target: 'dc1.example.test', ttl: 900, dynamic: false },
  );
  const txt = Buffer.concat([Buffer.from([11]), Buffer.from('v=spf1 -all'), Buffer.from([3]), Buffer.from('two')]);
  assert.deepEqual((decodeDnsRecord(blob(16, txt)) as { strings: string[] }).strings, ['v=spf1 -all', 'two']);
  const soa = Buffer.concat([
    u32(42),
    u32(900),
    u32(600),
    u32(86400),
    u32(3600),
    countName('dc1.example.test'),
    countName('hostmaster.example.test'),
  ]);
  assert.deepEqual(decodeDnsRecord(blob(6, soa)), {
    type: 'SOA',
    serial: 42,
    refresh: 900,
    retry: 600,
    expire: 86400,
    minimum: 3600,
    primary: 'dc1.example.test',
    admin: 'hostmaster.example.test',
    ttl: 900,
    dynamic: false,
  });
  assert.equal(decodeDnsRecord(blob(0, Buffer.alloc(8))), null, 'tombstone');
  assert.equal(decodeDnsRecord(blob(99, Buffer.alloc(4))), null, 'unknown type');
  assert.equal(decodeDnsRecord(Buffer.alloc(10)), null, 'too short');
  const bad = blob(5, Buffer.from([40, 3, 2]));
  assert.equal(decodeDnsRecord(bad), null, 'damaged name');
});

test('record validation and the samba-tool data argument', () => {
  const ok = (v: unknown) => recordData.safeParse(v).success;
  assert.ok(ok({ type: 'A', address: '10.0.0.1' }));
  assert.ok(!ok({ type: 'A', address: '10.0.0.256' }));
  assert.ok(ok({ type: 'AAAA', address: '2001:db8::1' }));
  assert.ok(!ok({ type: 'CNAME', target: 'bad name' }));
  assert.ok(!ok({ type: 'TXT', strings: ['quote"inside'] }));
  assert.ok(!ok({ type: 'TXT', strings: ['back\\slash'] }));
  assert.ok(!ok({ type: 'SRV', target: 'x.y', port: 70000, priority: 0, weight: 0 }));
  assert.ok(recordName.safeParse('@').success);
  assert.ok(recordName.safeParse('*.web').success);
  assert.ok(recordName.safeParse('_ldap._tcp').success);
  assert.ok(!recordName.safeParse('web.*').success);
  assert.ok(!recordName.safeParse('-bad').success);
  assert.ok(!dnsFqdn.safeParse('a..b').success);
  assert.equal(sambaToolData({ type: 'MX', exchange: 'mail.x', preference: 10 }), 'mail.x 10');
  assert.equal(sambaToolData({ type: 'SRV', target: 'dc1.x', port: 389, priority: 0, weight: 100 }), 'dc1.x 389 0 100');
  assert.equal(sambaToolData({ type: 'TXT', strings: ['a b', 'c'] }), '"a b" "c"');
  for (const r of [
    { type: 'A', address: '1.2.3.4' },
    { type: 'AAAA', address: '::1' },
    { type: 'NS', target: 'ns.x' },
  ] as const)
    assert.ok(sambaToolData(r).length > 0);
  assert.ok(sameRecord({ type: 'CNAME', target: 'DC1.x.' }, { type: 'CNAME', target: 'dc1.x' }));
  assert.ok(!sameRecord({ type: 'A', address: '1.1.1.1' }, { type: 'AAAA', address: '::1' }));
  assert.ok(sameRecord({ type: 'A', address: '1.1.1.1' }, { type: 'A', address: '1.1.1.1' }));
  assert.ok(sameRecord({ type: 'MX', exchange: 'm.x', preference: 1 }, { type: 'MX', exchange: 'M.X', preference: 1 }));
  assert.ok(
    !sameRecord(
      { type: 'SRV', target: 'a', port: 1, priority: 0, weight: 0 },
      { type: 'SRV', target: 'a', port: 2, priority: 0, weight: 0 },
    ),
  );
  assert.ok(sameRecord({ type: 'TXT', strings: ['a'] }, { type: 'TXT', strings: ['a'] }));
  assert.equal(ownerName('@', 'x.test'), 'x.test');
  assert.equal(ownerName('www', 'x.test'), 'www.x.test');
});

test('the records a writable DC registers (dns_update_list), PDC and GC extras; DC record names', () => {
  const o = { dnsDomain: 'example.test', dnsForest: 'example.test', domainGuid: 'dom-guid' };
  const dc = {
    hostname: 'dc1.example.test',
    ntdsGuid: 'ntds-guid',
    site: 'Default-First-Site-Name',
    pdc: false,
    gc: false,
    addresses: ['10.0.0.1'],
  };
  const plain = expectedDcRecords(dc, o);
  const names = plain.map((r) => `${r.record.type} ${r.name}`);
  assert.ok(names.includes('SRV _ldap._tcp.example.test'));
  assert.ok(names.includes('CNAME ntds-guid._msdcs.example.test'));
  assert.ok(names.includes('SRV _ldap._tcp.dom-guid.domains._msdcs.example.test'));
  assert.ok(!names.includes('SRV _ldap._tcp.pdc._msdcs.example.test'));
  assert.ok(!names.some((n) => n.includes('_gc')));
  const full = expectedDcRecords(
    { ...dc, pdc: true, gc: true, addresses: ['10.0.0.1', 'fd00::1'] },
    { ...o, dnsForest: 'forest.test' },
  );
  const fn = full.map((r) => `${r.record.type} ${r.name}`);
  assert.ok(fn.includes('SRV _ldap._tcp.pdc._msdcs.example.test'));
  assert.ok(fn.includes('SRV _gc._tcp.forest.test'));
  assert.ok(fn.includes('AAAA dc1.example.test'));
  assert.ok(fn.includes('NS forest.test'));
  const ctx = { dnsDomain: 'example.test', dnsForest: 'example.test', dcHostnames: ['dc1.example.test'] };
  for (const r of plain) assert.ok(isDcRecordName(r.name, ctx), r.name);
  assert.ok(!isDcRecordName('www.example.test', ctx));
  assert.ok(!isDcRecordName('_sip._tcp.example.test', ctx));
});
