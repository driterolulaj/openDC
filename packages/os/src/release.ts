// SPDX-License-Identifier: AGPL-3.0-only
/** os-release(5) parsing and adapter selection. The only place that looks at distro identity. */
import { readFile } from 'node:fs/promises';
import { arch as nodeArch } from 'node:os';
import type { AdapterId, Arch, OsRelease } from './types.ts';

export function parseOsRelease(text: string, arch: Arch = currentArch()): OsRelease {
  const kv = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    }
    kv.set(line.slice(0, eq), v);
  }
  const id = (kv.get('ID') ?? 'linux').toLowerCase();
  const codename = kv.get('VERSION_CODENAME');
  return {
    id,
    idLike: (kv.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    versionId: kv.get('VERSION_ID') ?? '',
    ...(codename ? { versionCodename: codename } : {}),
    prettyName: kv.get('PRETTY_NAME') ?? id,
    arch,
  };
}

export function currentArch(): Arch {
  return nodeArch() === 'arm64' ? 'arm64' : 'x86_64';
}

export async function readOsRelease(path = '/etc/os-release'): Promise<OsRelease> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = await readFile('/usr/lib/os-release', 'utf8');
  }
  return parseOsRelease(text);
}

const FAMILIES: [AdapterId, string[]][] = [
  ['debian', ['debian', 'ubuntu']],
  ['rhel', ['rhel', 'centos', 'fedora', 'rocky', 'almalinux']],
  ['suse', ['suse', 'opensuse', 'opensuse-leap', 'sles']],
  ['arch', ['arch']],
  ['alpine', ['alpine']],
];

export function adapterFor(release: OsRelease): AdapterId | null {
  const ids = [release.id, ...release.idLike];
  for (const [adapter, members] of FAMILIES) if (ids.some((i) => members.includes(i))) return adapter;
  return null;
}
