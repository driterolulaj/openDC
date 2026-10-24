// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Adapter conformance suite for real hosts (lab VMs, nightly CI). Run as root on the host under test:
 *   node --conditions=development --test packages/os/src/conformance.lab.ts
 * It writes only below a temporary managed root and reads service state; it changes nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { detectActions, detectFacts, PosixFileActions } from './index.ts';

if (process.platform !== 'linux') {
  test('conformance suite needs a Linux host', { skip: true }, () => undefined);
} else {
  const facts = await detectFacts();
  const actions = await detectActions();

  test(`adapter ${facts.adapter} recognises ${facts.release.prettyName}`, () => {
    assert.ok(facts.release.id);
    assert.ok(facts.release.versionId);
    assert.equal(actions.facts.adapter, facts.adapter);
  });

  test('platform paths are absolute and the secrets dir is never a managed root', () => {
    for (const p of [facts.paths.etc, facts.paths.secrets, facts.paths.lib, facts.paths.state, facts.paths.run])
      assert.ok(isAbsolute(p), p);
    for (const r of facts.paths.managedRoots()) {
      assert.ok(isAbsolute(r), r);
      assert.ok(!r.startsWith(facts.paths.secrets), r);
    }
  });

  test('core binaries resolve to absolute paths', async () => {
    for (const b of ['systemctl', 'journalctl', 'hostname'] as const)
      assert.ok(isAbsolute(await facts.binaries.resolve(b)), b);
  });

  test('support verdict for every role', async () => {
    for (const role of ['primary-dc', 'dc', 'rodc', 'member', 'managed-node'] as const) {
      const v = await facts.support(role);
      assert.ok([1, 2, 'unsupported'].includes(v.tier), `${role}: ${String(v.tier)}`);
    }
  });

  test('environment kinds are detected', async () => {
    assert.ok(['selinux', 'apparmor', 'none'].includes(await facts.macKind()));
    assert.ok(['systemd-resolved', 'resolv.conf', 'networkmanager'].includes(await facts.resolverKind()));
    assert.ok(
      ['netplan', 'networkmanager', 'ifupdown', 'systemd-networkd', 'unknown'].includes(await facts.networkKind()),
    );
  });

  test('service status of a unit that always exists', async () => {
    const s = await actions.services.status('systemd-journald');
    assert.equal(s.active, 'active');
  });

  test('system info', async () => {
    const i = await actions.system.info();
    assert.ok(i.hostname && i.fqdn && i.kernel);
    assert.ok(i.cpus > 0 && i.memTotal > 0);
  });

  test('managed file round trip with owner and mode on a real filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opendc-conf-'));
    try {
      const files = new PosixFileActions([root]);
      const p = join(root, 'x', 'y.conf');
      const w = await files.writeManaged(p, 'a\n', { uid: 0, gid: 0 }, 0o640);
      assert.equal(w.changed, true);
      const { statSync } = await import('node:fs');
      const st = statSync(p);
      assert.equal(st.mode & 0o777, 0o640);
      assert.equal(st.uid, 0);
      assert.equal((await files.writeManaged(p, 'b\n', { uid: 0, gid: 0 }, 0o640)).previousSha256, w.sha256);
      assert.equal((await files.restorePrevious(p)).restored, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
