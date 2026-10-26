// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kea DHCPv4 on this node (ROADMAP Phase 3, Spike S4). `dhcp.apply` renders the configuration from typed data
 * (never takes a Kea configuration), checks it with `kea-dhcp4 -t`, swaps it in as Kea's user and applies it with
 * the control socket's `config-reload` (Kea keeps running); a failed reload restores the previous file. A node
 * that serves no DHCP stops Kea. `dhcp.leases` reads the leases through the same socket (lease_cmds hook).
 */
import { randomBytes } from 'node:crypto';
import { copyFile, chown, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { OpResult } from '@opendc/shared/agent';
import { renderKea4, type KeaApplyArgs } from '@opendc/shared/dhcp';
import { writeSystemFile, type OsActions } from '@opendc/os';

/** One command over Kea's Unix control socket (Kea answers and closes the connection). */
export function keaCommand(
  socket: string,
  command: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ result: number; text?: string; arguments?: unknown }> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socket);
    let body = '';
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error(`Kea did not answer ${String(command.command)} within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify(command)));
    c.on('data', (d: string) => (body += d));
    c.on('end', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(body) as
          | { result: number; text?: string; arguments?: unknown }
          | { result: number; text?: string; arguments?: unknown }[];
        resolve(Array.isArray(r) ? (r[0] ?? { result: 1, text: 'empty answer' }) : r);
      } catch {
        reject(new Error(`unreadable answer from Kea: ${body.slice(0, 200)}`));
      }
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** uid/gid of a local account from /etc/passwd (Node has no getpwnam). */
async function account(user: string): Promise<{ uid: number; gid: number } | null> {
  const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
  for (const line of passwd.split('\n')) {
    const [n, , uid, gid] = line.split(':');
    if (n === user && uid && gid) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

export async function keaApply(
  os: OsActions,
  a: KeaApplyArgs,
  pki: { keys: string; trust: string },
): Promise<OpResult<'dhcp.apply'>> {
  const k = await os.facts.kea();
  const unit = k.unit;
  const active = async (): Promise<boolean> => (await os.services.status(unit).catch(() => null))?.active === 'active';
  if (!a.enabled) {
    if (await active()) {
      await os.services.disable(unit, true);
      return { changed: true, action: 'stopped' };
    }
    return { changed: false, action: 'none' };
  }
  const missing: string[] = [];
  for (const p of os.facts.packageNames('kea')) if (!(await os.packages.installed(p))) missing.push(p);
  if (missing.length) await os.packages.install(missing);
  const owner = await account(k.user);

  // the HA channel uses this node's certificate (copied where Kea's user can read it)
  let tls: { cert: string; key: string; ca: string } | null = null;
  if (a.ha) {
    const dir = join(dirname(k.configFile), 'opendc-tls');
    const node = {
      cert: join(pki.keys, 'node.pem'),
      key: join(pki.keys, 'node.key'),
      ca: join(pki.trust, 'ca-bundle.pem'),
    };
    const have = (await readFile(node.cert, 'utf8').catch(() => '')).trim() !== '';
    if (have) {
      tls = { cert: join(dir, 'node.pem'), key: join(dir, 'node.key'), ca: join(dir, 'ca-bundle.pem') };
      for (const [from, to] of [
        [node.cert, tls.cert],
        [node.key, tls.key],
        [node.ca, tls.ca],
      ] as const) {
        await writeSystemFile(to, await readFile(from, 'utf8'), 0o640);
        if (owner) await chown(to, 0, owner.gid);
      }
      if (owner) await chown(dir, owner.uid, owner.gid);
    }
  }

  const json = `${JSON.stringify(renderKea4(a, { hooksDir: k.hooksDir, leaseFile: k.leaseFile, controlSocket: k.controlSocket, tls }), null, 2)}\n`;
  const current = await readFile(k.configFile, 'utf8').catch(() => null);
  if (current === json && (await active())) return { changed: false, action: 'none' };

  // the candidate must pass Kea's own check before it replaces anything; as Kea's user, because Kea's AppArmor
  // profile denies root the DAC override it would need for /etc/kea (0750 _kea)
  const candidate = join(dirname(k.configFile), `.opendc-${randomBytes(4).toString('hex')}.conf`);
  await writeFile(candidate, json, { mode: 0o640 });
  try {
    if (owner) await chown(candidate, owner.uid, owner.gid);
    await os.exec(await os.facts.binaries.resolve('kea-dhcp4'), ['-t', candidate], {
      timeoutMs: 60_000,
      ...(owner ? { user: owner } : {}),
    });
  } catch (e) {
    throw new PlatformError('validation.invalid', {
      issues: `Kea rejected the configuration: ${(e instanceof Error ? e.message : String(e)).slice(-400)}`,
    });
  } finally {
    await rm(candidate, { force: true });
  }
  await writeSystemFile(k.configFile, json, 0o640);
  if (owner) await chown(k.configFile, owner.uid, owner.gid);

  if (!(await active())) {
    await os.services.enable(unit, false);
    await os.services.startAndWait(unit, 60_000);
    return { changed: true, action: 'started' };
  }
  const r = await keaCommand(k.controlSocket, { command: 'config-reload' }).catch((e: unknown) => ({
    result: 1,
    text: e instanceof Error ? e.message : String(e),
  }));
  if (r.result !== 0) {
    // back to the previous configuration (writeSystemFile kept it next to the file)
    await copyFile(`${k.configFile}.opendc-prev`, k.configFile).catch(() => undefined);
    if (owner) await chown(k.configFile, owner.uid, owner.gid).catch(() => undefined);
    await keaCommand(k.controlSocket, { command: 'config-reload' }).catch(() => undefined);
    throw new PlatformError('validation.invalid', { issues: `Kea did not apply the configuration: ${r.text ?? '?'}` });
  }
  return { changed: true, action: 'reloaded' };
}

export async function keaLeases(os: OsActions): Promise<OpResult<'dhcp.leases'>> {
  const k = await os.facts.kea();
  // a node that serves no DHCP has no leases (and no Kea to ask)
  if ((await os.services.status(k.unit).catch(() => null))?.active !== 'active') return { leases: [] };
  const r = await keaCommand(k.controlSocket, { command: 'lease4-get-all' });
  // 3 = empty
  if (r.result !== 0 && r.result !== 3)
    throw new PlatformError('validation.invalid', { issues: `Kea: ${r.text ?? '?'}` });
  const leases = ((r.arguments as { leases?: Record<string, unknown>[] } | undefined)?.leases ?? []).map((l) => ({
    ip: typeof l['ip-address'] === 'string' ? l['ip-address'] : '',
    mac: typeof l['hw-address'] === 'string' ? l['hw-address'] : '',
    hostname: typeof l.hostname === 'string' && l.hostname ? l.hostname : null,
    subnetId: Number(l['subnet-id'] ?? 0),
    expires: new Date((Number(l.cltt ?? 0) + Number(l['valid-lft'] ?? 0)) * 1000).toISOString(),
    state: Number(l.state ?? 0),
  }));
  return { leases };
}
