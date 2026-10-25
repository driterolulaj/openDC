// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, first, modifyRecord, parseLdif, unicodePwd } from './ldif.ts';
import { parseFsmoShow, parseLevelShow, parseSmbConfGlobal } from './info.ts';
import { domainHeadAces } from './platform.ts';
import { networkOf } from './provision.ts';

test('LDIF records encode unsafe values as base64 and reject bad attribute names', () => {
  const add = addRecord('CN=a b,DC=x', { objectClass: ['top', 'user'], description: ': looks like ldif\n-' });
  assert.match(add, /^dn: CN=a b,DC=x\nchangetype: add\nobjectClass: top\nobjectClass: user\ndescription:: /);
  assert.ok(!add.includes('looks like'), 'the dangerous value is base64-encoded');
  const pwd = modifyRecord('CN=u,DC=x', [{ op: 'replace', attr: 'unicodePwd', values: [unicodePwd('Pässword1')] }]);
  assert.match(pwd, /replace: unicodePwd\nunicodePwd:: [A-Za-z0-9+/=]+\n-\n\n$/);
  assert.equal(
    Buffer.from(pwd.split('unicodePwd:: ')[1]?.split('\n')[0] ?? '', 'base64').toString('utf16le'),
    '"Pässword1"',
  );
  assert.throws(() => addRecord('CN=x', { 'bad name': 'v' }));
  // a DN that starts with a space is encoded too
  assert.match(addRecord(' CN=x', { cn: 'x' }), /^dn:: /);
});

test('ldbsearch output parsing: folding, base64, comments, several records', () => {
  const text = [
    '# record 1',
    'dn: CN=Administrator,CN=Users,DC=x',
    'objectSid: S-1-5-21-1-2-3-500',
    'description:: w6TDtsO8',
    'nTSecurityDescriptor: O:BAG:BAD:AI(A;;RP;;;AU)(OA;CI;CCDC;bf967aba-0de6-11d0-a2',
    ' 85-00aa003049e2;;S-1-5-21-1-2-3-1103)',
    '',
    '# record 2',
    'dn: CN=Guest,CN=Users,DC=x',
    'member: a',
    'member: b',
    '',
    '# returned 2 records',
  ].join('\n');
  const [a, b] = parseLdif(text);
  assert.equal(a?.dn, 'CN=Administrator,CN=Users,DC=x');
  assert.equal(first(a, 'objectSid'), 'S-1-5-21-1-2-3-500');
  assert.equal(first(a, 'description'), 'äöü');
  assert.ok(first(a, 'nTSecurityDescriptor')?.includes('S-1-5-21-1-2-3-1103'), 'unfolded');
  assert.deepEqual(b?.attrs.get('member'), ['a', 'b']);
  assert.equal(first(null, 'x'), null);
});

test('delegation ACEs cover the five administered classes for create/delete and full control', () => {
  const aces = domainHeadAces('S-1-5-21-1-2-3-1103');
  assert.equal(aces.match(/\(OA;CI;CCDC;/g)?.length, 5);
  assert.equal(aces.match(/\(OA;CIIO;GA;;/g)?.length, 5);
  assert.ok(!aces.includes('(A;'), 'no unrestricted allow on the domain head');
});

test('samba-tool output parsers', () => {
  const fsmo = parseFsmoShow(
    [
      'SchemaMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=x',
      'PdcEmulationMasterRole owner: CN=NTDS Settings,CN=DC2,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=x',
      'something else',
    ].join('\n'),
  );
  assert.deepEqual(
    fsmo.map((r) => [r.role, r.ownerServer]),
    [
      ['schema', 'DC1'],
      ['pdc', 'DC2'],
    ],
  );
  assert.deepEqual(
    parseLevelShow(
      'Domain and forest function level for domain x\n\nForest function level: (Windows) 2008 R2\nDomain function level: (Windows) 2008 R2\nLowest function level of a DC: (Windows) 2016\n',
    ),
    { forest: '2008 R2', domain: '2008 R2', lowestDc: '2016' },
  );
  const conf = parseSmbConfGlobal(
    '# x\n[global]\n\tnetbios name = DC1\n\trealm = EXAMPLE.COM\n\tserver   role = active directory domain controller\n[sysvol]\n\tpath = /x\n',
  );
  assert.equal(conf.get('realm'), 'EXAMPLE.COM');
  assert.equal(conf.get('server role'), 'active directory domain controller');
  assert.equal(conf.get('path'), undefined);
});

test('networkOf derives the CIDR of an interface address', () => {
  assert.equal(networkOf('10.97.10.11', 24), '10.97.10.0/24');
  assert.equal(networkOf('192.168.5.130', 25), '192.168.5.128/25');
  assert.equal(networkOf('172.16.3.4', 0), '0.0.0.0/0');
});

test('SDProp: protected DACL from AdminSDHolder, and the match is order-insensitive', async () => {
  const { protectedDacl, daclMatches } = await import('./sdprop.ts');
  const holder =
    'O:DAG:DAD:AI(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;DA)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;LCRPLORC;;;AU)(OA;CIID;CCDC;bf967aba-0de6-11d0-a285-00aa003049e2;;S-1-5-21-1-2-3-1103)S:AI(OU;CIIOIDSA;WP;x;y;WD)';
  const dacl = protectedDacl(holder);
  assert.ok(dacl.startsWith('D:P(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;DA)'));
  assert.ok(!dacl.includes('1103'), 'inherited ACEs (the delegation) are dropped');
  assert.ok(dacl.includes(';;WD)') && dacl.includes(';;BA)'));
  const stored = `O:DAG:DA${dacl.replace('D:P', 'D:PAI')}S:AI(OU;CIIOIDSA;WP;x;y;WD)`;
  assert.ok(daclMatches(stored, dacl));
  const reordered = `O:DAG:DAD:P${[...dacl.slice(3).matchAll(/\([^)]*\)/g)]
    .map((m) => m[0])
    .reverse()
    .join('')}`;
  assert.ok(daclMatches(reordered, dacl));
  assert.ok(!daclMatches(stored.replace('D:PAI', 'D:AI'), dacl), 'not protected');
  assert.ok(!daclMatches(stored.replace(';;;AU)', ';;;AU)(A;;GA;;;S-1-5-21-1-2-3-1103)'), dacl), 'extra ACE');
});

test('smb.conf dns forwarder: replaced in [global], added when missing, removed when empty', async () => {
  const { withDnsForwarder } = await import('./provision.ts');
  const conf = '[global]\n\tdns forwarder = 127.0.0.53\n\trealm = X\n\n[sysvol]\n\tpath = /x\n';
  assert.equal(
    withDnsForwarder(conf, ['8.8.8.8', '1.1.1.1']),
    '[global]\n\tdns forwarder = 8.8.8.8 1.1.1.1\n\trealm = X\n\n[sysvol]\n\tpath = /x\n',
  );
  assert.equal(
    withDnsForwarder('[global]\n\trealm = X\n[sysvol]\n', ['9.9.9.9']),
    '[global]\n\trealm = X\n\tdns forwarder = 9.9.9.9\n[sysvol]\n',
  );
  assert.equal(withDnsForwarder(conf, []), '[global]\n\trealm = X\n\n[sysvol]\n\tpath = /x\n');
});

test('pre-flight recognises Samba AD task names as Samba (resume of an unfinished setup)', async () => {
  const { isSambaProcess } = await import('../setup/preflight.ts');
  for (const p of ['samba', 'dns[master]', 'kdc(3)', 'ldap[master]', 'smbd', 'winbindd'])
    assert.ok(isSambaProcess(p), p);
  for (const p of ['systemd-resolve', 'named', 'slapd', null]) assert.ok(!isSambaProcess(p), String(p));
});

test('smb.conf [global] parameters: set, replace, remove, read; other sections untouched', async () => {
  const { withGlobalParam, globalParam, withDnsForwarder } = await import('./smbconf.ts');
  const conf = '[global]\n\tworkgroup = X\n\tdns  forwarder = 1.1.1.1\n\n[sysvol]\n\tdns forwarder = not-global\n';
  assert.equal(globalParam(conf, 'dns forwarder'), '1.1.1.1');
  assert.equal(globalParam(conf, 'dns zone scavenging'), null);
  const a = withGlobalParam(conf, 'dns zone scavenging', 'yes');
  assert.match(a, /\[global\][^[]*\tdns zone scavenging = yes/);
  assert.equal(globalParam(a, 'dns zone scavenging'), 'yes');
  const b = withDnsForwarder(a, ['9.9.9.9', '1.0.0.1']);
  assert.equal(globalParam(b, 'dns forwarder'), '9.9.9.9 1.0.0.1');
  assert.ok(b.includes('dns forwarder = not-global'), 'other sections stay');
  const c = withGlobalParam(withDnsForwarder(b, []), 'dns zone scavenging', null);
  assert.equal(globalParam(c, 'dns forwarder'), null);
  assert.equal(globalParam(c, 'dns zone scavenging'), null);
  assert.ok(c.includes('workgroup = X'));
  assert.equal(withGlobalParam('[global]\n', 'x y', '1'), '[global]\n\tx y = 1\n');
  // a new parameter goes after the section's last setting, not after its blank lines
  assert.equal(withGlobalParam('[global]\n\ta = 1\n\n[x]\n', 'b', '2'), '[global]\n\ta = 1\n\tb = 2\n\n[x]\n');
});
