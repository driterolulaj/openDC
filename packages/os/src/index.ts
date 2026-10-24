// SPDX-License-Identifier: AGPL-3.0-only
/** Picks the adapter for the running host. Only packages/os may inspect distro identity (ADR-0008). */
import { PlatformError } from '@opendc/shared';
import { adapterFor, readOsRelease } from './release.ts';
import { DebianFacts, debianActions } from './debian/index.ts';
import type { OsActions, OsFacts, OsRelease } from './types.ts';

export * from './types.ts';
export { parseOsRelease, adapterFor, readOsRelease } from './release.ts';
export { exec, SAFE_PATH, type Exec, type ExecResult } from './exec.ts';
export { MIN_DC_SAMBA, parseSambaVersion } from './debian/index.ts';
export { PosixFileActions, PREV_SUFFIX } from './posix/files.ts';
export { parseSystemctlShow } from './posix/systemd.ts';

function unsupported(release: OsRelease): never {
  throw new PlatformError('os.unsupported', {
    os: release.prettyName,
    role: 'any',
    reason: 'no OS adapter for this distribution family',
    fix: 'Use a Tier-1 distribution (Debian 12/13, Ubuntu 24.04/26.04).',
  });
}

export async function detectFacts(release?: OsRelease): Promise<OsFacts> {
  const r = release ?? (await readOsRelease());
  if (adapterFor(r) === 'debian') return new DebianFacts({ release: r });
  return unsupported(r);
}

/** Only opendc-agent calls this. */
export async function detectActions(release?: OsRelease): Promise<OsActions> {
  const r = release ?? (await readOsRelease());
  if (adapterFor(r) === 'debian') return debianActions({ release: r });
  return unsupported(r);
}
