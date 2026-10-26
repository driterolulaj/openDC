// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kea DHCPv4 and DHCPv6 on this node (ROADMAP Phase 3, Spike S4). `dhcp.apply` renders each daemon's
 * configuration from typed data (never takes a Kea configuration), checks it with `kea-dhcp4/6 -t`, swaps it in as
 * Kea's user and applies it with the control socket's `config-reload` (Kea keeps running); a failed reload restores
 * the previous file. A daemon runs only while this node serves subnets of its family. `dhcp.leases` reads the
 * leases through the same sockets (lease_cmds hook).
 */
import { randomBytes } from 'node:crypto';
import { copyFile, chown, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { OpResult } from '@opendc/shared/agent';
import { renderKea4, renderKea6, type KeaApplyArgs } from '@opendc/shared/dhcp';
import { writeSystemFile, type KeaDaemon, type OsActions } from '@opendc/os';

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

type Action = OpResult<'dhcp.apply'>['action'];
type Owner = { uid: number; gid: number } | null;

async function ensurePackages(os: OsActions, logical: string): Promise<void> {
  const missing: string[] = [];
  for (const p of os.facts.packageNames(logical)) if (!(await os.packages.installed(p))) missing.push(p);
  if (missing.length) await os.packages.install(missing);
}

/** One daemon: stopped when `json` is null, otherwise checked, swapped in and reloaded (or started). */
async function applyDaemon(os: OsActions, d: KeaDaemon, owner: Owner, json: string | null): Promise<Action> {
  const active = async (): Promise<boolean> =>
    (await os.services.status(d.unit).catch(() => null))?.active === 'active';
  if (json === null) {
    if (!(await active())) return 'none';
    await os.services.disable(d.unit, true);
    return 'stopped';
  }
  // a freshly installed package runs the distribution's example configuration until ours replaces it
  const current = await readFile(d.configFile, 'utf8').catch(() => null);
  if (current === json && (await active())) return 'none';

  // the candidate must pass Kea's own check before it replaces anything; as Kea's user, because Kea's AppArmor
  // profile denies root the DAC override it would need for /etc/kea (0750 _kea)
  const candidate = join(dirname(d.configFile), `.opendc-${randomBytes(4).toString('hex')}.conf`);
  await writeFile(candidate, json, { mode: 0o640 });
  try {
    if (owner) await chown(candidate, owner.uid, owner.gid);
    await os.exec(await os.facts.binaries.resolve(d.binary), ['-t', candidate], {
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
  await writeSystemFile(d.configFile, json, 0o640);
  if (owner) await chown(d.configFile, owner.uid, owner.gid);

  if (!(await active())) {
    await os.services.enable(d.unit, false);
    await os.services.startAndWait(d.unit, 60_000);
    return 'started';
  }
  const r = await keaCommand(d.controlSocket, { command: 'config-reload' }).catch((e: unknown) => ({
    result: 1,
    text: e instanceof Error ? e.message : String(e),
  }));
  if (r.result !== 0) {
    // back to the previous configuration (writeSystemFile kept it next to the file)
    await copyFile(`${d.configFile}.opendc-prev`, d.configFile).catch(() => undefined);
    if (owner) await chown(d.configFile, owner.uid, owner.gid).catch(() => undefined);
    await keaCommand(d.controlSocket, { command: 'config-reload' }).catch(() => undefined);
    throw new PlatformError('validation.invalid', { issues: `Kea did not apply the configuration: ${r.text ?? '?'}` });
  }
  return 'reloaded';
}

/**
 * The HA channel carries lease updates: mutual TLS with this node's certificate (copied where Kea's user can read
 * it), never plain HTTP.
 */
async function haTls(
  configDir: string,
  owner: Owner,
  pki: { keys: string; trust: string },
): Promise<{ cert: string; key: string; ca: string }> {
  const dir = join(configDir, 'opendc-tls');
  const node = {
    cert: join(pki.keys, 'node.pem'),
    key: join(pki.keys, 'node.key'),
    ca: join(pki.trust, 'ca-bundle.pem'),
  };
  if ((await readFile(node.cert, 'utf8').catch(() => '')).trim() === '')
    throw new PlatformError('validation.invalid', {
      issues: "the DHCP HA channel needs this node's certificate, and it has none yet",
    });
  const tls = { cert: join(dir, 'node.pem'), key: join(dir, 'node.key'), ca: join(dir, 'ca-bundle.pem') };
  for (const [from, to] of [
    [node.cert, tls.cert],
    [node.key, tls.key],
    [node.ca, tls.ca],
  ] as const) {
    await writeSystemFile(to, await readFile(from, 'utf8'), 0o640);
    if (owner) await chown(to, 0, owner.gid);
  }
  if (owner) await chown(dir, owner.uid, owner.gid);
  return tls;
}

export async function keaApply(
  os: OsActions,
  a: KeaApplyArgs,
  pki: { keys: string; trust: string },
): Promise<OpResult<'dhcp.apply'>> {
  const k = await os.facts.kea();
  const want4 = a.enabled && a.subnets.length > 0;
  const want6 = a.enabled && a.subnets6.length > 0;
  // packages first: they create Kea's account
  if (want4) await ensurePackages(os, k.v4.packages);
  if (want6) await ensurePackages(os, k.v6.packages);
  const owner = want4 || want6 ? await account(k.user) : null;
  const tls = a.ha && (want4 || want6) ? await haTls(dirname(k.v4.configFile), owner, pki) : null;
  const paths = (d: KeaDaemon) => ({
    hooksDir: k.hooksDir,
    leaseFile: d.leaseFile,
    controlSocket: d.controlSocket,
    tls,
  });
  const json = (o: Record<string, unknown>): string => `${JSON.stringify(o, null, 2)}\n`;
  const action = await applyDaemon(os, k.v4, owner, want4 ? json(renderKea4(a, paths(k.v4))) : null);
  const action6 = await applyDaemon(os, k.v6, owner, want6 ? json(renderKea6(a, paths(k.v6))) : null);
  return { changed: action !== 'none' || action6 !== 'none', action, action6 };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function keaLeases(os: OsActions): Promise<OpResult<'dhcp.leases'>> {
  const k = await os.facts.kea();
  const leases: OpResult<'dhcp.leases'>['leases'] = [];
  for (const [family, d] of [
    [4, k.v4],
    [6, k.v6],
  ] as const) {
    // a daemon that isn't running has no leases (and no socket to ask)
    if ((await os.services.status(d.unit).catch(() => null))?.active !== 'active') continue;
    const r = await keaCommand(d.controlSocket, { command: family === 4 ? 'lease4-get-all' : 'lease6-get-all' });
    // 3 = empty
    if (r.result !== 0 && r.result !== 3)
      throw new PlatformError('validation.invalid', { issues: `Kea: ${r.text ?? '?'}` });
    for (const l of (r.arguments as { leases?: Record<string, unknown>[] } | undefined)?.leases ?? [])
      leases.push({
        family,
        ip: str(l['ip-address']),
        mac: str(l['hw-address']),
        duid: family === 6 && str(l.duid) ? str(l.duid) : null,
        hostname: str(l.hostname) || null,
        subnetId: Number(l['subnet-id'] ?? 0),
        expires: new Date((Number(l.cltt ?? 0) + Number(l['valid-lft'] ?? 0)) * 1000).toISOString(),
        state: Number(l.state ?? 0),
      });
  }
  return { leases };
}
