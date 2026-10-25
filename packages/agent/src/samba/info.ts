// SPDX-License-Identifier: AGPL-3.0-only
/** Read-only Samba facts: samba.status, samba.fsmo.show, samba.level.show. */
import { readFile } from 'node:fs/promises';
import type { OpResult } from '@opendc/shared/agent';
import type { OsActions } from '@opendc/os';
import { SambaLocal } from './local.ts';

/** [global] parameters of smb.conf (keys lower-cased, whitespace-normalised). */
export function parseSmbConfGlobal(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inGlobal = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inGlobal = section[1]?.trim().toLowerCase() === 'global';
      continue;
    }
    if (!inGlobal) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out.set(line.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' '), line.slice(eq + 1).trim());
  }
  return out;
}

const FSMO_NAMES: Record<string, OpResult<'samba.fsmo.show'>['roles'][number]['role']> = {
  SchemaMasterRole: 'schema',
  InfrastructureMasterRole: 'infrastructure',
  RidAllocationMasterRole: 'rid',
  PdcEmulationMasterRole: 'pdc',
  DomainNamingMasterRole: 'naming',
  DomainDnsZonesMasterRole: 'domaindns',
  ForestDnsZonesMasterRole: 'forestdns',
};

/** `samba-tool fsmo show`: "<Role> owner: CN=NTDS Settings,CN=<server>,CN=Servers,..." per line. */
export function parseFsmoShow(text: string): OpResult<'samba.fsmo.show'>['roles'] {
  const roles: OpResult<'samba.fsmo.show'>['roles'] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\w+) owner: (.+)$/.exec(line);
    const role = m ? FSMO_NAMES[m[1] ?? ''] : undefined;
    if (!m || !role) continue;
    const ownerDn = (m[2] ?? '').trim();
    const server = /^CN=NTDS Settings,CN=([^,]+),/i.exec(ownerDn)?.[1] ?? null;
    roles.push({ role, ownerDn, ownerServer: server });
  }
  return roles;
}

/** `samba-tool domain level show`. */
export function parseLevelShow(text: string): OpResult<'samba.level.show'> {
  const get = (re: RegExp): string | null =>
    re
      .exec(text)?.[1]
      ?.replace(/\(Windows\)\s*/, '')
      .trim() ?? null;
  return {
    forest: get(/Forest function level:\s*(.+)/),
    domain: get(/Domain function level:\s*(.+)/),
    lowestDc: get(/Lowest function level of a DC:\s*(.+)/),
  };
}

export async function sambaStatus(os: OsActions): Promise<OpResult<'samba.status'>> {
  const samba = new SambaLocal(os);
  const v = await os.facts.samba.version();
  const conf = parseSmbConfGlobal(await readFile(samba.paths.smbConf, 'utf8').catch(() => ''));
  const unit = await os.services.status('samba-ad-dc').catch(() => ({ active: 'unknown' }));
  return {
    installed: v !== null,
    version: v ? `${String(v.major)}.${String(v.minor)}.${String(v.patch)}` : null,
    provisioned: await samba.provisioned(),
    serverRole: conf.get('server role') ?? null,
    realm: conf.get('realm') ?? null,
    netbiosDomain: conf.get('workgroup') ?? null,
    active: unit.active,
  };
}

export async function fsmoShow(os: OsActions): Promise<OpResult<'samba.fsmo.show'>> {
  const samba = new SambaLocal(os);
  return { roles: parseFsmoShow(await samba.tool(['fsmo', 'show', '-H', samba.samDb])) };
}

export async function levelShow(os: OsActions): Promise<OpResult<'samba.level.show'>> {
  const samba = new SambaLocal(os);
  return parseLevelShow(await samba.tool(['domain', 'level', 'show', '-H', samba.samDb]));
}
