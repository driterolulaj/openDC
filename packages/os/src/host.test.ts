// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupId, parseChronyTracking, parseIpAddr, parseSs, rewriteHosts, writeSystemFile } from './posix/host.ts';
import { parseAptPolicy } from './debian/index.ts';
import { PREV_SUFFIX } from './posix/files.ts';

test('rewriteHosts replaces every line naming the host and keeps the rest', () => {
  const before =
    '127.0.0.1\tlocalhost\n127.0.1.1 dc1.old.example dc1\n10.0.0.5 other # dc1 in a comment\n::1 ip6-localhost\n';
  const after = rewriteHosts(before, 'dc1.ad.example.com', '10.0.0.11');
  assert.equal(
    after,
    '127.0.0.1\tlocalhost\n10.0.0.5 other # dc1 in a comment\n::1 ip6-localhost\n10.0.0.11\tdc1.ad.example.com\tdc1\n',
  );
  assert.equal(rewriteHosts(after, 'dc1.ad.example.com', '10.0.0.11'), after, 'idempotent');
});

test('ip -j addr parsing keeps global addresses and the DHCP flag', () => {
  const json = JSON.stringify([
    { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
    {
      ifname: 'eth0',
      addr_info: [
        { family: 'inet', local: '10.0.0.11', prefixlen: 24, scope: 'global' },
        { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' },
      ],
    },
    { ifname: 'eth1', addr_info: [{ family: 'inet', local: '192.168.1.9', prefixlen: 24, dynamic: true }] },
  ]);
  assert.deepEqual(parseIpAddr(json), [
    { iface: 'eth0', family: 'inet', address: '10.0.0.11', prefix: 24, dynamic: false },
    { iface: 'eth0', family: 'inet6', address: 'fe80::1', prefix: 64, dynamic: false },
    { iface: 'eth1', family: 'inet', address: '192.168.1.9', prefix: 24, dynamic: true },
  ]);
});

test('ss parsing: protocol, address, port and process', () => {
  const text = [
    'udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=10,fd=14))',
    'tcp   LISTEN 0      4096   [::]:445                [::]:*       users:(("smbd",pid=11,fd=5))',
    'tcp   LISTEN 0      128    0.0.0.0:22              0.0.0.0:*',
    'garbage',
  ].join('\n');
  assert.deepEqual(parseSs(text), [
    { proto: 'udp', address: '127.0.0.53', port: 53, process: 'systemd-resolve' },
    { proto: 'tcp', address: '::', port: 445, process: 'smbd' },
    { proto: 'tcp', address: '0.0.0.0', port: 22, process: null },
  ]);
});

test('chronyc -c tracking parsing', () => {
  const synced = 'C0A80001,192.168.0.1,3,1792886000.1,-0.000012,0.0,0.0,0.0,0.0,0.0,0.0,0.0,64.0,Normal';
  assert.deepEqual(parseChronyTracking(synced), { synchronized: true, offsetSec: -0.000012, reference: '192.168.0.1' });
  const unsynced = '00000000,,0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,Not synchronised';
  assert.equal(parseChronyTracking(unsynced).synchronized, false);
  assert.equal(parseChronyTracking('').offsetSec, null);
});

test('apt-cache policy parsing', () => {
  const text = 'samba:\n  Installed: (none)\n  Candidate: 2:4.22.11+dfsg-0+deb13u1\n  Version table:\n';
  assert.deepEqual(parseAptPolicy(text), { installed: null, candidate: '2:4.22.11+dfsg-0+deb13u1' });
  assert.deepEqual(parseAptPolicy(''), { installed: null, candidate: null });
});

test('writeSystemFile: atomic, keeps the previous version, refuses symlinks unless asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendc-sysfile-'));
  const f = join(dir, 'resolv.conf');
  assert.equal(await writeSystemFile(f, 'a\n', 0o644), true);
  assert.equal(await writeSystemFile(f, 'a\n', 0o644), false, 'unchanged content is not rewritten');
  await writeSystemFile(f, 'b\n', 0o644);
  assert.equal(readFileSync(f, 'utf8'), 'b\n');
  assert.equal(readFileSync(f + PREV_SUFFIX, 'utf8'), 'a\n');
  if (process.platform !== 'win32') {
    const link = join(dir, 'link');
    symlinkSync(f, link);
    await assert.rejects(writeSystemFile(link, 'c\n', 0o644));
    await writeSystemFile(link, 'c\n', 0o644, { replaceSymlink: true });
    assert.equal(readFileSync(link, 'utf8'), 'c\n');
    assert.equal(readFileSync(f, 'utf8'), 'b\n', 'the symlink target is untouched');
  }
  assert.ok(existsSync(f));
});

test('groupId reads /etc/group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendc-group-'));
  const g = join(dir, 'group');
  writeFileSync(g, 'root:x:0:\n_chrony:x:996:\nbroken\n');
  assert.equal(await groupId(g, '_chrony'), 996);
  assert.equal(await groupId(g, 'nope'), null);
});
