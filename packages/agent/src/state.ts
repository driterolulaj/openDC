// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node-local state the agent owns: /etc/opendc/node.json (role and domain of this node) and the secrets
 * directory (root 0600 files, delivered to services with LoadCredential=). Secret values never leave the
 * agent over a socket (agent-operations.md §3.2).
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nodeRoles, type NodeRole } from '@opendc/shared/manifest';

export const nodeStateSchema = z.object({
  schemaVersion: z.literal(1),
  role: z.enum(nodeRoles),
  domain: z.string(),
  realm: z.string(),
  domainDn: z.string(),
  domainSid: z.string(),
  fqdn: z.string(),
  setupAt: z.string(),
});
export type NodeState = z.infer<typeof nodeStateSchema>;

async function atomicWrite(path: string, data: string | Buffer, mode: number): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  await rename(tmp, path);
}

export class NodeStateFile {
  readonly #path: string;

  constructor(etcDir: string) {
    this.#path = join(etcDir, 'node.json');
  }

  async read(): Promise<NodeState | null> {
    try {
      const parsed = nodeStateSchema.safeParse(JSON.parse(await readFile(this.#path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async role(): Promise<NodeRole | null> {
    return (await this.read())?.role ?? null;
  }

  async write(state: NodeState): Promise<void> {
    await mkdir(join(this.#path, '..'), { recursive: true, mode: 0o755 });
    await atomicWrite(this.#path, JSON.stringify(state, null, 2) + '\n', 0o644);
  }
}

export class SecretFiles {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(name: string): string {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) throw new TypeError(`Invalid secret name ${name}`);
    return join(this.#dir, name);
  }

  async put(name: string, data: string | Buffer): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.#path(name), data, 0o600);
  }

  async get(name: string): Promise<Buffer | null> {
    return readFile(this.#path(name)).catch(() => null);
  }
}

/** A random password that satisfies AD complexity (all four classes) and has ~190 bits of entropy. */
export function servicePassword(): string {
  return `Od1!${randomBytes(32).toString('base64url')}`;
}
