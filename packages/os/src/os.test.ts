// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import { adapterFor, parseOsRelease } from './release.ts';
import { DebianFacts, parseSambaVersion } from './debian/index.ts';
import { PosixFileActions, PREV_SUFFIX } from './posix/files.ts';
import { parseSystemctlShow } from './posix/systemd.ts';
import { osI18n } from './i18n.ts';
import type { Exec } from './exec.ts';

const FIXTURES = {
  debian12:
    'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nID=debian\n',
  debian13: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_ID="13"\nVERSION_CODENAME=trixie\nID=debian\n',
  ubuntu2404:
    'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\n',
  ubuntu2604: 'PRETTY_NAME="Ubuntu 26.04 LTS"\nVERSION_ID="26.04"\nID=ubuntu\nID_LIKE=debian\n',
  ubuntu2204: 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
  rocky9:
    'NAME="Rocky Linux"\nVERSION_ID="9.4"\nID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n',
  alpine: 'ID=alpine\nVERSION_ID=3.20.0\nPRETTY_NAME="Alpine Linux v3.20"\n',
  weird: '# comment\n\nNAME=\'Single "Quoted"\'\nID=Custom\nPRETTY_NAME="Esc \\"x\\""\nBROKEN\n=nokey\n',
};

test('os-release parsing and adapter selection', () => {
  const d12 = parseOsRelease(FIXTURES.debian12, 'x86_64');
  assert.deepEqual(d12, {
    id: 'debian',
    idLike: [],
    versionId: '12',
    versionCodename: 'bookworm',
    prettyName: 'Debian GNU/Linux 12 (bookworm)',
    arch: 'x86_64',
  });
  assert.deepEqual(parseOsRelease(FIXTURES.ubuntu2404, 'arm64').idLike, ['debian']);
  assert.equal(adapterFor(d12), 'debian');
  assert.equal(adapterFor(parseOsRelease(FIXTURES.ubuntu2604)), 'debian');
  assert.equal(adapterFor(parseOsRelease(FIXTURES.rocky9)), 'rhel');
  assert.equal(adapterFor(parseOsRelease(FIXTURES.alpine)), 'alpine');
  const weird = parseOsRelease(FIXTURES.weird);
  assert.equal(weird.id, 'custom');
  assert.equal(weird.prettyName, 'Esc "x"');
  assert.equal(weird.versionId, '');
  assert.equal(adapterFor(weird), null);
});

/** Fake exec: answers `samba --version` with the given version line. */
const sambaExec =
  (version: string | null): Exec =>
  async (bin, argv) => {
    if (bin.endsWith('/samba') && argv[0] === '--version') {
      if (version === null) throw new PlatformError('os.command-failed', { binary: bin, exitCode: 1, stderr: '' });
      return { stdout: `Version ${version}\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected exec ${bin} ${argv.join(' ')}`);
  };

/** Facts whose binary lookup is stubbed so tests don't depend on the host. */
function facts(fixture: string, samba: string | null, hasSambaBinary = true): DebianFacts {
  return new DebianFacts({
    release: parseOsRelease(fixture, 'x86_64'),
    exec: sambaExec(samba),
    root: '/tmp/opendc-test',
    isExecutable: async (p) => p.startsWith('/usr/sbin/') && (hasSambaBinary || !p.endsWith('/samba')),
  });
}

test('binary lookup reports the package to install', async () => {
  const f = facts(FIXTURES.debian13, null, false);
  assert.equal(await f.binaries.resolve('systemctl'), '/usr/sbin/systemctl');
  await assert.rejects(
    f.binaries.resolve('samba'),
    (e: unknown) => e instanceof PlatformError && e.code === 'os.binary-missing' && e.fix.includes('samba-ad-dc'),
  );
  assert.equal(await f.samba.mode(), 'absent');
  assert.equal(await facts(FIXTURES.debian13, '4.22.11').samba.mode(), 'native');
});

test('support matrix: Tier-1 releases and the DC Samba minimum (Q10)', async () => {
  // Debian 12 stock Samba 4.17 is refused for DCs and points at backports
  const d12 = await facts(FIXTURES.debian12, '4.17.12-Debian').support('primary-dc');
  assert.equal(d12.tier, 'unsupported');
  assert.equal(d12.reasons[0]?.code, 'samba-too-old');
  assert.equal(d12.reasons[0]?.fixKey, 'os:support.enable-bookworm-backports');
  // ... and accepted with the backports version
  assert.equal((await facts(FIXTURES.debian12, '4.22.6-Debian').support('dc')).tier, 1);
  assert.equal((await facts(FIXTURES.debian13, '4.22.11-Debian').support('primary-dc')).tier, 1);
  assert.equal((await facts(FIXTURES.ubuntu2404, '4.19.5-Ubuntu').support('dc')).tier, 1);
  const old = await facts(FIXTURES.ubuntu2604, '4.18.0').support('rodc');
  assert.equal(old.reasons[0]?.fixKey, 'os:support.upgrade-samba');
  // members don't need Samba at all
  assert.deepEqual(await facts(FIXTURES.debian12, '4.17.12').support('member'), {
    tier: 1,
    sambaMode: 'n/a',
    reasons: [],
  });
  // Samba not installed yet: allowed, with an informational reason
  const notYet = await facts(FIXTURES.debian13, null, false).support('primary-dc');
  assert.equal(notYet.tier, 1);
  assert.equal(notYet.reasons[0]?.code, 'samba-not-installed');
  // non-Tier-1 releases
  const u22 = await facts(FIXTURES.ubuntu2204, '4.15.0').support('member');
  assert.equal(u22.tier, 'unsupported');
  assert.equal(u22.reasons[0]?.code, 'release-not-tier1');
});

test('every support reason has en and de texts', () => {
  for (const k of Object.keys(osI18n.en.support)) assert.ok(k in osI18n.de.support, k);
});

test('paths, units and packages', () => {
  const f = facts(FIXTURES.debian13, '4.22.11');
  assert.ok(f.paths.managedFile('opendc.demo').replaceAll('\\', '/').endsWith('/etc/opendc/generated/demo.conf'));
  assert.throws(
    () => f.paths.managedFile('nope'),
    (e: unknown) => e instanceof PlatformError && e.code === 'os.unknown-path-key',
  );
  for (const root of f.paths.managedRoots()) assert.ok(!root.includes('secrets'), root);
  assert.equal(f.unitName('samba-ad-dc'), 'samba-ad-dc.service');
  assert.equal(f.unitName('opendc-api'), 'opendc-api.service');
  assert.equal(f.unitName('x.socket'), 'x.socket');
  assert.ok(f.packageNames('samba-dc').includes('samba-ad-dc'));
  assert.deepEqual(f.packageNames('jq'), ['jq']);
});

test('parsers: samba --version and systemctl show', () => {
  assert.deepEqual(parseSambaVersion('Version 4.22.11-Debian-4.22.11+dfsg-0+deb13u1\n'), {
    major: 4,
    minor: 22,
    patch: 11,
    raw: 'Version 4.22.11-Debian-4.22.11+dfsg-0+deb13u1',
  });
  assert.equal(parseSambaVersion('garbage'), null);
  assert.deepEqual(
    parseSystemctlShow(
      'ActiveState=active\nSubState=running\nUnitFileState=enabled\nActiveEnterTimestamp=Sat 2026-10-24 12:00:00 UTC\n',
    ),
    {
      active: 'active',
      sub: 'running',
      enabled: true,
      since: 'Sat 2026-10-24 12:00:00 UTC',
    },
  );
  assert.deepEqual(
    parseSystemctlShow('ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nActiveEnterTimestamp=n/a\n'),
    {
      active: 'inactive',
      sub: 'dead',
      enabled: false,
    },
  );
  assert.deepEqual(parseSystemctlShow(''), { active: 'unknown', sub: 'unknown', enabled: false });
});

test('managed file writes: atomic, previous kept, restore, roots enforced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendc-files-'));
  try {
    const managed = join(root, 'managed');
    const files = new PosixFileActions([managed]);
    const target = join(managed, 'sub', 'demo.conf');

    const w1 = await files.writeManaged(target, 'one\n', null, 0o644);
    assert.equal(w1.changed, true);
    assert.equal(w1.previousSha256, null);
    assert.equal(readFileSync(target, 'utf8'), 'one\n');
    assert.ok(!existsSync(target + PREV_SUFFIX));

    const same = await files.writeManaged(target, 'one\n', null, 0o644);
    assert.deepEqual(same, { changed: false, sha256: w1.sha256, previousSha256: w1.sha256 });

    const w2 = await files.writeManaged(target, 'two\n', null, 0o644);
    assert.equal(w2.previousSha256, w1.sha256);
    assert.equal(readFileSync(target + PREV_SUFFIX, 'utf8'), 'one\n');
    assert.deepEqual(await files.readManaged(target), { content: 'two\n', sha256: w2.sha256 });

    assert.deepEqual(await files.restorePrevious(target), { restored: true, sha256: w1.sha256 });
    assert.equal(readFileSync(target, 'utf8'), 'one\n');
    assert.equal((await files.restorePrevious(target)).restored, false);

    assert.equal(await files.readManaged(join(managed, 'missing.conf')), null);

    const outside = (e: unknown): boolean => e instanceof PlatformError && e.code === 'os.path-outside-roots';
    await assert.rejects(files.writeManaged(join(root, 'elsewhere.conf'), 'x', null, 0o644), outside);
    await assert.rejects(files.writeManaged(join(managed, '..', 'escape.conf'), 'x', null, 0o644), outside);
    await assert.rejects(files.writeManaged(managed, 'x', null, 0o644), outside);

    if (process.platform !== 'win32') {
      // a symlinked directory that points outside the roots
      mkdirSync(join(root, 'evil'));
      symlinkSync(join(root, 'evil'), join(managed, 'link'));
      await assert.rejects(files.writeManaged(join(managed, 'link', 'x.conf'), 'x', null, 0o644), outside);
      // a symlinked final component
      writeFileSync(join(root, 'evil', 'target'), 'secret');
      symlinkSync(join(root, 'evil', 'target'), join(managed, 'sub', 'symlinked.conf'));
      await assert.rejects(files.writeManaged(join(managed, 'sub', 'symlinked.conf'), 'x', null, 0o644), outside);
      assert.equal(readFileSync(join(root, 'evil', 'target'), 'utf8'), 'secret');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a managed root reached through a symlink (or a Windows short name) still works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opendc-alias-'));
  try {
    const real = join(root, 'real');
    mkdirSync(real);
    // On Windows the temp dir itself is often a short name (C:\Users\RUNNER~1\...), which realpath expands.
    const alias = process.platform === 'win32' ? real : join(root, 'alias');
    if (process.platform !== 'win32') symlinkSync(real, alias);
    const files = new PosixFileActions([alias]);
    const p = join(alias, 'x.conf');
    assert.equal((await files.writeManaged(p, 'one', null, 0o644)).changed, true);
    // The second write re-reads the canonical target; that must not be refused as "outside the roots".
    assert.equal((await files.writeManaged(p, 'two', null, 0o644)).previousSha256 !== null, true);
    assert.equal((await files.restorePrevious(p)).restored, true);
    assert.equal(readFileSync(join(real, 'x.conf'), 'utf8'), 'one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
