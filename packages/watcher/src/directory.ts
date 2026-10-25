// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The watcher's view of its DC: identity for checkpoints (dsServiceName, invocationId), the PDC emulator check
 * for leader handlers (ADR-0017) and DirSync, over the shared ServiceLdap (read-only watch account).
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { guidFromBytes, type ServiceLdap } from '@opendc/shared/ldap';
import type { DcIdentity, DirectoryPort } from './engine.ts';

const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

export class WatchedDc implements DirectoryPort {
  readonly #ldap: ServiceLdap;
  readonly #domainDn: string;

  constructor(ldap: ServiceLdap, domainDn: string) {
    this.#ldap = ldap;
    this.#domainDn = domainDn;
  }

  async identity(): Promise<DcIdentity> {
    const [dse] = await this.#ldap.search('', { scope: 'base', attributes: ['dsServiceName', 'dnsHostName'] });
    const dsServiceName = first(dse?.dsServiceName);
    if (!dsServiceName) throw Object.assign(new Error('rootDSE without dsServiceName'), { code: 'ldap.unreachable' });
    const [ntds] = await this.#ldap.search(dsServiceName, {
      scope: 'base',
      attributes: ['invocationId'],
      buffers: ['invocationId'],
    });
    const inv = ntds?.invocationId;
    const [head] = await this.#ldap.search(this.#domainDn, { scope: 'base', attributes: ['fSMORoleOwner'] });
    return {
      dsServiceName,
      invocationId: Buffer.isBuffer(inv) ? guidFromBytes(inv) : '',
      dnsHostName: first(dse?.dnsHostName),
      pdc: first(head?.fSMORoleOwner).toLowerCase() === dsServiceName.toLowerCase(),
    };
  }

  dirsync(
    nc: string,
    o: { filter: string; attributes: string[]; cookie: Buffer },
  ): Promise<{ entries: import('ldapts').Entry[]; cookie: Buffer }> {
    return this.#ldap.dirsync(nc, o);
  }
}

export interface InboxEntry {
  ts: string;
  actor: string;
  action: string;
  result: 'success' | 'failure';
  targetGuid?: string;
  targetDn?: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Drops audit entries into the API's inbox (ADR-0013): one file per entry, written under a dot name and renamed,
 * so the API never reads half a file. The directory is 0730 api:watch; the file must be readable by the API.
 */
export function writeInbox(dir: string, e: InboxEntry): void {
  const name = `${Date.now().toString().padStart(15, '0')}-${randomBytes(6).toString('hex')}.json`;
  const tmp = join(dir, `.${name}`);
  writeFileSync(tmp, JSON.stringify(e), { flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(dir, name));
}
