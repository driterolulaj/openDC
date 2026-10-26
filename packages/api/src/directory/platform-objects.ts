// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generic store for OpenDC platform objects in the directory (directory-object-model.md §3): one
 * msDS-App-Configuration object per item below a container of CN=OpenDC,CN=System, cn = UUID, displayName =
 * human name, msDS-Settings = "opendc:v1:" + JSON envelope {schemaVersion, kind, rev, updatedBy, updatedAt,
 * data}. Readers skip values they can't parse; writers never overwrite an object written by a newer schema
 * version; updates are compare-and-swap (delete the old value and add the new one in one modify).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from '@opendc/shared';
import { childDn, eq } from '@opendc/shared/ldap';
import type { DirectoryService } from './service.ts';
import { str } from './model.ts';

export const PAYLOAD_PREFIX = 'opendc:v1:';

export interface Actor {
  sid: string;
  name: string;
}

export interface Stored<T> {
  id: string;
  dn: string;
  raw: string;
  schemaVersion: number;
  rev: number;
  updatedBy: { sid: string; name: string };
  updatedAt: string;
  data: T;
}

const envelopeSchema = z.object({
  schemaVersion: z.number().int(),
  kind: z.string(),
  rev: z.number().int(),
  updatedBy: z.object({ sid: z.string(), name: z.string(), nodeGuid: z.string() }),
  updatedAt: z.string(),
  data: z.unknown(),
});

export function parsePayload<T extends z.ZodType>(
  raw: string | null,
  kind: string,
  data: T,
): (Omit<z.infer<typeof envelopeSchema>, 'data'> & { data: z.output<T> }) | null {
  if (!raw?.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    const env = envelopeSchema.safeParse(JSON.parse(raw.slice(PAYLOAD_PREFIX.length)));
    if (!env.success || env.data.kind !== kind) return null;
    const d = data.safeParse(env.data.data);
    return d.success ? { ...env.data, data: d.data } : null;
  } catch {
    return null;
  }
}

export class PlatformObjects<T extends z.ZodType> {
  readonly #dir: () => DirectoryService;
  readonly #path: string[];
  readonly #kind: string;
  readonly #schemaVersion: number;
  readonly #data: T;
  readonly #name: (d: z.output<T>) => string;

  /** `path`: container below CN=OpenDC, outermost first (e.g. ['RBAC', 'Roles']). */
  constructor(o: {
    dir: () => DirectoryService;
    path: string[];
    kind: string;
    schemaVersion: number;
    data: T;
    name: (d: z.output<T>) => string;
  }) {
    this.#dir = o.dir;
    this.#path = o.path;
    this.#kind = o.kind;
    this.#schemaVersion = o.schemaVersion;
    this.#data = o.data;
    this.#name = o.name;
  }

  container(): string {
    return this.#path.reduce((dn, cn) => childDn(dn, 'CN', cn), this.#dir().platformDn);
  }

  async list(): Promise<Stored<z.output<T>>[]> {
    const entries = await this.#dir().ldap.search(this.container(), {
      scope: 'one',
      filter: eq('objectClass', 'msDS-App-Configuration'),
      attributes: ['cn', 'msDS-Settings'],
    });
    const out: Stored<z.output<T>>[] = [];
    for (const e of entries) {
      const raw = str(e, 'msDS-Settings');
      const p = parsePayload(raw, this.#kind, this.#data);
      if (!p || !raw) continue;
      out.push({
        id: str(e, 'cn') ?? '',
        dn: e.dn,
        raw,
        schemaVersion: p.schemaVersion,
        rev: p.rev,
        updatedBy: p.updatedBy,
        updatedAt: p.updatedAt,
        data: p.data,
      });
    }
    return out;
  }

  async get(id: string): Promise<Stored<z.output<T>>> {
    const found = (await this.list()).find((x) => x.id === id);
    if (!found) throw new PlatformError('request.not-found', { what: `${this.#kind} ${id}` });
    return found;
  }

  #payload(rev: number, actor: Actor, data: z.output<T>): string {
    return (
      PAYLOAD_PREFIX +
      JSON.stringify({
        schemaVersion: this.#schemaVersion,
        kind: this.#kind,
        rev,
        updatedBy: { sid: actor.sid, name: actor.name, nodeGuid: '' },
        updatedAt: new Date().toISOString(),
        data,
      })
    );
  }

  async create(actor: Actor, data: z.output<T>): Promise<string> {
    const id = randomUUID();
    const add = () =>
      this.#dir().ldap.add(childDn(this.container(), 'CN', id), {
        objectClass: ['top', 'msDS-App-Configuration'],
        displayName: [this.#name(data)],
        'msDS-Settings': [this.#payload(1, actor, data)],
      });
    try {
      await add();
    } catch (e) {
      // a module's containers (e.g. CN=DHCP,CN=Subnets) appear with its first object
      if (!(e instanceof PlatformError && e.code === 'request.not-found')) throw e;
      await this.#ensureContainers();
      await add();
    }
    return id;
  }

  async #ensureContainers(): Promise<void> {
    let dn = this.#dir().platformDn;
    for (const cn of this.#path) {
      dn = childDn(dn, 'CN', cn);
      const [e] = await this.#dir().ldap.search(dn, { scope: 'base', attributes: ['cn'] });
      if (!e) await this.#dir().ldap.add(dn, { objectClass: ['top', 'container'] });
    }
  }

  /** Compare-and-swap: request.conflict if the stored value changed since `current` was read. */
  async update(actor: Actor, current: Stored<z.output<T>>, data: z.output<T>): Promise<void> {
    if (current.schemaVersion > this.#schemaVersion)
      throw new PlatformError('request.conflict', { what: `${this.#name(data)} (written by a newer OpenDC version)` });
    try {
      await this.#dir().ldap.modify(current.dn, [
        { op: 'delete', attr: 'msDS-Settings', values: [current.raw] },
        { op: 'add', attr: 'msDS-Settings', values: [this.#payload(current.rev + 1, actor, data)] },
        { op: 'replace', attr: 'displayName', values: [this.#name(data)] },
      ]);
    } catch (e) {
      if (e instanceof PlatformError && (e.code === 'directory.invalid' || e.code === 'ldap.operation-failed'))
        throw new PlatformError('request.conflict', { what: this.#name(data) }, { cause: e });
      throw e;
    }
  }

  async delete(current: Stored<z.output<T>>): Promise<void> {
    await this.#dir().ldap.del(current.dn);
  }
}
