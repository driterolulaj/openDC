// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Group policy objects (ROADMAP Phase 3). samba-tool's own `gpo create/backup/restore` write SYSVOL over SMB with an
 * account's credentials; the agent works with the DC's local privileges instead (ADR-0012): the container through
 * the local sam.ldb, its SYSVOL folder on the file system, then `samba-tool ntacl sysvolreset` derives the folder's
 * ACL from the container's, as provisioning does for the default GPOs. Whatever writes SYSVOL runs only on the PDC
 * emulator, whose SYSVOL is the source of truth (ADR-0019). Backups stay on that DC in the OpenDC state directory
 * until backup targets arrive (Phase 4). Links are directory-only (`samba-tool gpo setlink/dellink` against
 * sam.ldb) and work on any writable DC.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import { gpoBackupMeta, restoredVersion, withGptVersion, type GpoBackupMeta } from '@opendc/shared/gpo';
import { childDn, eq, guidToBytes } from '@opendc/shared/ldap';
import type { OsActions } from '@opendc/os';
import { parseFsmoShow } from './info.ts';
import { addRecord, first, modifyRecord, type LdifAttrs, type Mod } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const ATTRS = [
  'displayName',
  'flags',
  'versionNumber',
  'gPCMachineExtensionNames',
  'gPCUserExtensionNames',
  'gPCWQLFilter',
];

interface Where {
  domainDn: string;
  realm: string;
  /** CN=Policies,CN=System,<domain> */
  policies: string;
  /** <sysvol>/<realm>/Policies */
  dir: string;
}

async function where(samba: SambaLocal): Promise<Where> {
  const domainDn = await samba.domainDn();
  const realm = domainDn
    .split(',')
    .filter((p) => /^dc=/i.test(p))
    .map((p) => p.slice(3))
    .join('.')
    .toLowerCase();
  // the realm folder's case is whatever provisioning chose
  const names = await readdir(samba.paths.sysvol).catch(() => [] as string[]);
  const folder = names.find((n) => n.toLowerCase() === realm) ?? realm;
  return {
    domainDn,
    realm,
    policies: childDn(childDn(domainDn, 'CN', 'System'), 'CN', 'Policies'),
    dir: join(samba.paths.sysvol, folder, 'Policies'),
  };
}

const gpcDn = (w: Where, gpo: string): string => childDn(w.policies, 'CN', gpo);

/** The GPO's SYSVOL folder (GPMC and samba-tool differ in the GUID's case). */
async function folderOf(w: Where, gpo: string): Promise<string | null> {
  const names = await readdir(w.dir).catch(() => [] as string[]);
  const name = names.find((n) => n.toUpperCase() === gpo);
  return name ? join(w.dir, name) : null;
}

/** SYSVOL is written on the PDC emulator only; the other DCs copy it from there (ADR-0019). */
async function requirePdc(samba: SambaLocal, hostname: string): Promise<void> {
  const pdc = parseFsmoShow(await samba.tool(['fsmo', 'show', '-H', samba.samDb])).find((r) => r.role === 'pdc');
  if (pdc?.ownerServer?.toLowerCase() !== hostname.toLowerCase())
    throw new PlatformError('gpo.not-pdc', { pdc: pdc?.ownerServer ?? '?' });
}

async function gpoTool(samba: SambaLocal, argv: string[]): Promise<string> {
  try {
    return await samba.tool(argv, { timeoutMs: 600_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PlatformError(
      'gpo.failed',
      { reason: msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? '?' },
      { cause: e },
    );
  }
}

/** The folder ACLs follow the containers' (what `samba-tool gpo create` does over SMB). */
const sysvolReset = (samba: SambaLocal): Promise<string> => gpoTool(samba, ['ntacl', 'sysvolreset']);

interface GpcValues {
  displayName: string;
  flags: number;
  version: number;
  machineExtensionNames: string | null;
  userExtensionNames: string | null;
  wqlFilter: string | null;
}

function gpcAttrs(w: Where, gpo: string, v: GpcValues): LdifAttrs {
  return {
    objectClass: ['top', 'container', 'groupPolicyContainer'],
    displayName: v.displayName,
    gPCFileSysPath: `\\\\${w.realm}\\sysvol\\${w.realm}\\Policies\\${gpo}`,
    flags: String(v.flags),
    versionNumber: String(v.version),
    gPCFunctionalityVersion: '2',
    ...(v.machineExtensionNames ? { gPCMachineExtensionNames: v.machineExtensionNames } : {}),
    ...(v.userExtensionNames ? { gPCUserExtensionNames: v.userExtensionNames } : {}),
    ...(v.wqlFilter ? { gPCWQLFilter: v.wqlFilter } : {}),
  };
}

async function addGpc(samba: SambaLocal, w: Where, gpo: string, v: GpcValues): Promise<void> {
  const dn = gpcDn(w, gpo);
  await samba.add(
    [
      addRecord(dn, gpcAttrs(w, gpo, v)),
      addRecord(childDn(dn, 'CN', 'User'), { objectClass: ['top', 'container'] }),
      addRecord(childDn(dn, 'CN', 'Machine'), { objectClass: ['top', 'container'] }),
    ].join('\n'),
  );
}

/** Puts `source` (a folder) in place of the GPO's folder: staged next to it, swapped by renames. */
async function swapFolder(w: Where, gpo: string, source: string | null, version: number): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const staged = join(w.dir, `.opendc-new-${tag}`);
  if (source) await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
  else {
    await mkdir(join(staged, 'MACHINE'), { recursive: true });
    await mkdir(join(staged, 'USER'), { recursive: true });
  }
  const ini = join(staged, 'GPT.INI');
  await writeFile(ini, withGptVersion(await readFile(ini, 'latin1').catch(() => null), version), 'latin1');
  const current = await folderOf(w, gpo);
  const old = join(w.dir, `.opendc-old-${tag}`);
  if (current) await rename(current, old);
  await rename(staged, current ?? join(w.dir, gpo));
  await rm(old, { recursive: true, force: true });
}

export async function gpoCreate(
  samba: SambaLocal,
  hostname: string,
  a: OpParsedArgs<'samba.gpo.create'>,
): Promise<OpResult<'samba.gpo.create'>> {
  await requirePdc(samba, hostname);
  const w = await where(samba);
  const gpo = `{${randomUUID().toUpperCase()}}`;
  // the folder first: a container without its folder is a broken GPO for clients
  await swapFolder(w, gpo, null, 0);
  try {
    await addGpc(samba, w, gpo, {
      displayName: a.displayName,
      flags: 0,
      version: 0,
      machineExtensionNames: null,
      userExtensionNames: null,
      wqlFilter: null,
    });
  } catch (e) {
    const f = await folderOf(w, gpo);
    if (f) await rm(f, { recursive: true, force: true });
    throw new PlatformError(
      'gpo.failed',
      { reason: e instanceof Error ? e.message.slice(-200) : String(e) },
      { cause: e },
    );
  }
  await sysvolReset(samba);
  return { gpo, dn: gpcDn(w, gpo) };
}

// ---- backups ----

const backupRoot = (os: OsActions): string => join(os.facts.paths.state, 'gpo-backups');

async function tally(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += (await stat(join(e.parentPath, e.name))).size;
  }
  return { files, bytes };
}

const info = (m: GpoBackupMeta): OpResult<'samba.gpo.backup'> => ({
  id: m.id,
  gpo: m.gpo,
  displayName: m.displayName,
  version: m.version,
  createdAt: m.createdAt,
  files: m.files,
  bytes: m.bytes,
});

async function readBackup(os: OsActions, id: string): Promise<GpoBackupMeta> {
  const raw = await readFile(join(backupRoot(os), id, 'backup.json'), 'utf8').catch(() => null);
  const m = raw ? gpoBackupMeta.safeParse(JSON.parse(raw)) : null;
  if (!m?.success || m.data.id !== id) throw new PlatformError('gpo.not-found', { what: `GPO backup ${id}` });
  return m.data;
}

export async function gpoBackup(
  samba: SambaLocal,
  os: OsActions,
  hostname: string,
  a: OpParsedArgs<'samba.gpo.backup'>,
): Promise<OpResult<'samba.gpo.backup'>> {
  await requirePdc(samba, hostname);
  const w = await where(samba);
  const e = await samba.get(gpcDn(w, a.gpo), ATTRS);
  const folder = await folderOf(w, a.gpo);
  if (!e || !folder) throw new PlatformError('gpo.not-found', { what: `GPO ${a.gpo}` });
  const id = randomUUID();
  const dir = join(backupRoot(os), id);
  await mkdir(backupRoot(os), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  try {
    await cp(folder, join(dir, 'files'), { recursive: true });
    const meta: GpoBackupMeta = {
      id,
      gpo: a.gpo,
      displayName: first(e, 'displayName') ?? a.gpo,
      version: Number(first(e, 'versionNumber') ?? 0),
      createdAt: new Date().toISOString(),
      ...(await tally(join(dir, 'files'))),
      flags: Number(first(e, 'flags') ?? 0),
      machineExtensionNames: first(e, 'gPCMachineExtensionNames'),
      userExtensionNames: first(e, 'gPCUserExtensionNames'),
      wqlFilter: first(e, 'gPCWQLFilter'),
    };
    await writeFile(join(dir, 'backup.json'), JSON.stringify(meta), { mode: 0o600 });
    return info(meta);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function gpoBackupList(os: OsActions): Promise<OpResult<'samba.gpo.backup.list'>> {
  const ids = await readdir(backupRoot(os)).catch(() => [] as string[]);
  const backups = [];
  for (const id of ids) {
    const m = await readBackup(os, id).catch(() => null);
    if (m) backups.push(info(m));
  }
  return { backups: backups.sort((x, y) => y.createdAt.localeCompare(x.createdAt)) };
}

export async function gpoBackupDelete(
  os: OsActions,
  a: OpParsedArgs<'samba.gpo.backup.delete'>,
): Promise<OpResult<'samba.gpo.backup.delete'>> {
  await readBackup(os, a.id);
  await rm(join(backupRoot(os), a.id), { recursive: true, force: true });
  return { id: a.id };
}

export async function gpoRestore(
  samba: SambaLocal,
  os: OsActions,
  hostname: string,
  a: OpParsedArgs<'samba.gpo.restore'>,
): Promise<OpResult<'samba.gpo.restore'>> {
  await requirePdc(samba, hostname);
  const m = await readBackup(os, a.backupId);
  const w = await where(samba);
  const gpo = a.newName ? `{${randomUUID().toUpperCase()}}` : m.gpo;
  const cur = a.newName ? null : await samba.get(gpcDn(w, gpo), ATTRS);
  // above both the current and the backed-up version, so every client applies it again
  const version = restoredVersion(cur ? Number(first(cur, 'versionNumber') ?? 0) : 0, m.version);
  const values: GpcValues = {
    displayName: a.newName ?? m.displayName,
    flags: m.flags,
    version,
    machineExtensionNames: m.machineExtensionNames,
    userExtensionNames: m.userExtensionNames,
    wqlFilter: m.wqlFilter,
  };
  await swapFolder(w, gpo, join(backupRoot(os), a.backupId, 'files'), version);
  if (cur) {
    // replace without values removes the attribute
    const opt = (attr: string, v: string | null): Mod => ({ op: 'replace', attr, values: v ? [v] : [] });
    await samba.modify(
      modifyRecord(gpcDn(w, gpo), [
        { op: 'replace', attr: 'displayName', values: [values.displayName] },
        { op: 'replace', attr: 'flags', values: [String(values.flags)] },
        { op: 'replace', attr: 'versionNumber', values: [String(version)] },
        opt('gPCMachineExtensionNames', values.machineExtensionNames),
        opt('gPCUserExtensionNames', values.userExtensionNames),
        opt('gPCWQLFilter', values.wqlFilter),
      ]),
    );
  } else await addGpc(samba, w, gpo, values);
  await sysvolReset(samba);
  return { gpo, created: !cur, version };
}

// ---- links ----

async function containerDn(samba: SambaLocal, guid: string): Promise<string> {
  const [e] = await samba.search(await samba.domainDn(), 'sub', eq('objectGUID', guidToBytes(guid)), ['objectClass']);
  if (!e) throw new PlatformError('gpo.not-found', { what: `Container ${guid}` });
  return e.dn;
}

export async function gpoSetLink(
  samba: SambaLocal,
  a: OpParsedArgs<'samba.gpo.setlink'>,
): Promise<OpResult<'samba.gpo.setlink'>> {
  const w = await where(samba);
  if (!(await samba.exists(gpcDn(w, a.gpo)))) throw new PlatformError('gpo.not-found', { what: `GPO ${a.gpo}` });
  const container = await containerDn(samba, a.container);
  const argv = ['gpo', 'setlink', container, a.gpo, '-H', samba.samDb];
  if (a.enforced) argv.push('--enforce');
  if (a.disabled) argv.push('--disable');
  await gpoTool(samba, argv);
  return { container };
}

export async function gpoDelLink(
  samba: SambaLocal,
  a: OpParsedArgs<'samba.gpo.dellink'>,
): Promise<OpResult<'samba.gpo.dellink'>> {
  const container = await containerDn(samba, a.container);
  await gpoTool(samba, ['gpo', 'dellink', container, a.gpo, '-H', samba.samDb]);
  return { container };
}
