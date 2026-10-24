// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Spike S2 (ROADMAP Phase 1): DirSync and change notification with ldapts against Samba.
 * Runs from a lab host against a lab DC; prints a markdown report.
 *
 *   S2_URL=ldaps://sdc1.small.opendc.test S2_CA=/path/ca.pem S2_USER=Administrator@small.opendc.test \
 *   S2_PASS=... node --conditions=development packages/watcher/src/s2.lab.ts [rights]
 *
 * "rights" mode only checks whether S2_USER may run DirSync (used to test the watch account's rights).
 */
import { readFileSync } from 'node:fs';
import { Attribute, Change, Client, type Entry } from 'ldapts';
import {
  DirSyncControl,
  DirSyncFlags,
  ShowDeletedControl,
  childDn,
  eq,
  ge,
  guidFromBytes,
  ldaptsFilter,
  or,
  present,
} from '@opendc/shared/ldap';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const url = env('S2_URL');
const ca = process.env.S2_CA ? readFileSync(process.env.S2_CA, 'utf8') : undefined;
const servername = process.env.S2_SERVERNAME ?? new URL(url).hostname;
const rows: [string, string][] = [];
const result = (check: string, outcome: string): void => {
  rows.push([check, outcome.replaceAll('|', '/')]);
};

async function connect(): Promise<Client> {
  const c = new Client({
    url,
    timeout: 20_000,
    connectTimeout: 5_000,
    tlsOptions: { ...(ca ? { ca } : {}), servername, minVersion: 'TLSv1.2' },
  });
  await c.bind(env('S2_USER'), env('S2_PASS'));
  return c;
}

async function rootDse(c: Client): Promise<Entry> {
  const r = await c.search('', {
    scope: 'base',
    filter: ldaptsFilter(present('objectClass')),
    attributes: ['defaultNamingContext', 'dsServiceName', 'highestCommittedUSN', 'supportedControl', 'dnsHostName'],
  });
  const e = r.searchEntries[0];
  if (!e) throw new Error('no rootDSE');
  return e;
}

interface Sync {
  entries: Entry[];
  cookie: Buffer;
  rounds: number;
}

/** One DirSync pass: keeps asking while the server reports more results. */
async function dirsync(c: Client, base: string, cookie: Buffer, flags = 0): Promise<Sync> {
  const entries: Entry[] = [];
  let ck = cookie;
  let rounds = 0;
  for (;;) {
    const ctl = new DirSyncControl({ flags, cookie: ck });
    const r = await c.search(
      base,
      {
        scope: 'sub',
        filter: ldaptsFilter(or(eq('objectClass', 'msDS-App-Configuration'), eq('objectClass', 'container'))),
        attributes: ['objectGUID', 'msDS-Settings', 'isDeleted', 'cn', 'whenChanged', 'uSNChanged'],
        explicitBufferAttributes: ['objectGUID'],
      },
      ctl,
    );
    entries.push(...r.searchEntries);
    rounds++;
    if (!ctl.response) throw new Error('DirSync response control missing');
    ck = ctl.response.cookie;
    if (!ctl.response.moreResults) return { entries, cookie: ck, rounds };
  }
}

const guidOf = (e: Entry): string => {
  const v = e.objectGUID;
  const b = Array.isArray(v) ? v[0] : v;
  return Buffer.isBuffer(b) ? guidFromBytes(b) : '?';
};

async function rightsCheck(): Promise<void> {
  const c = await connect();
  const base = String((await rootDse(c)).defaultNamingContext);
  try {
    const s = await dirsync(c, base, Buffer.alloc(0));
    console.log(`DIRSYNC-OK entries=${String(s.entries.length)}`);
  } catch (e) {
    console.log(`DIRSYNC-DENIED ${(e as Error).message.slice(0, 160)}`);
  }
  try {
    const s = await dirsync(c, base, Buffer.alloc(0), DirSyncFlags.objectSecurity);
    console.log(`DIRSYNC-OBJECT-SECURITY-OK entries=${String(s.entries.length)}`);
  } catch (e) {
    console.log(`DIRSYNC-OBJECT-SECURITY-DENIED ${(e as Error).message.slice(0, 160)}`);
  }
  await c.unbind();
}

async function main(): Promise<void> {
  if (process.argv.includes('rights')) return rightsCheck();
  const c = await connect();
  const dse = await rootDse(c);
  const base = String(dse.defaultNamingContext);
  const controls = ([] as unknown[]).concat(dse.supportedControl ?? []).map(String);
  result('DC / dsServiceName (checkpoint binding)', `${String(dse.dnsHostName)} / ${String(dse.dsServiceName)}`);
  result('highestCommittedUSN at start', String(dse.highestCommittedUSN));
  result('DirSync control advertised', controls.includes('1.2.840.113556.1.4.841') ? 'yes' : 'NO');
  result('Change notification control advertised', controls.includes('1.2.840.113556.1.4.528') ? 'yes' : 'no');

  const ntds = await c.search(String(dse.dsServiceName), {
    scope: 'base',
    attributes: ['invocationId'],
    explicitBufferAttributes: ['invocationId'],
  });
  const inv = ntds.searchEntries[0]?.invocationId;
  result('invocationId readable (restore detection)', Buffer.isBuffer(inv) ? guidFromBytes(inv) : 'not readable');

  const t0 = Date.now();
  const initial = await dirsync(c, base, Buffer.alloc(0));
  result(
    'initial full DirSync of msDS-App-Configuration + containers',
    `${String(initial.entries.length)} entries in ${String(initial.rounds)} round(s), ${String(Date.now() - t0)} ms, cookie ${String(initial.cookie.length)} bytes`,
  );

  const quiet = await dirsync(c, base, initial.cookie);
  result('DirSync with the fresh cookie, no changes', `${String(quiet.entries.length)} entries`);

  const parent = childDn(base, 'CN', 'System');
  const container = childDn(parent, 'CN', `OpenDC-S2-${String(Date.now())}`);
  const obj = childDn(container, 'CN', 'probe');
  await c.add(container, { objectClass: 'container' });
  await c.add(obj, {
    objectClass: 'msDS-App-Configuration',
    'msDS-Settings': 'opendc:v1:{"rev":1}',
    displayName: 'S2 probe',
  });
  const added = await dirsync(c, base, quiet.cookie);
  const addedProbe = added.entries.find((e) => e.dn.toLowerCase().startsWith('cn=probe,'));
  result(
    'add: container + object appear in the next DirSync',
    `${String(added.entries.length)} entries; probe attributes: ${
      addedProbe
        ? Object.keys(addedProbe)
            .filter((k) => k !== 'dn')
            .sort()
            .join(', ')
        : 'MISSING'
    }`,
  );
  const probeGuid = addedProbe ? guidOf(addedProbe) : '?';

  await c.modify(
    obj,
    new Change({
      operation: 'replace',
      modification: new Attribute({ type: 'msDS-Settings', values: ['opendc:v1:{"rev":2}'] }),
    }),
  );
  const modified = await dirsync(c, base, added.cookie);
  const m = modified.entries.find((e) => guidOf(e) === probeGuid);
  result(
    'modify: only the changed object, with changed attributes',
    m
      ? `1 of ${String(modified.entries.length)} entries; attributes: ${Object.keys(m)
          .filter((k) => k !== 'dn')
          .sort()
          .join(', ')}; msDS-Settings=${String(m['msDS-Settings'])}`
      : `NOT SEEN (${String(modified.entries.length)} entries)`,
  );

  // Reconnect with the saved cookie: changes since then must still be returned exactly once.
  await c.unbind();
  const c2 = await connect();
  const again = await dirsync(c2, base, modified.cookie);
  result('cookie survives a reconnect (no repeat of seen changes)', `${String(again.entries.length)} entries`);

  await c2.del(obj);
  const deleted = await dirsync(c2, base, again.cookie);
  const d = deleted.entries.find((e) => guidOf(e) === probeGuid);
  result(
    'delete: tombstone delivered by DirSync',
    d
      ? `yes: isDeleted=${String(d.isDeleted)}; dn=${d.dn.slice(0, 80)}`
      : `NO (${String(deleted.entries.length)} entries)`,
  );

  // USN fallback: uSNChanged polling with Show Deleted also returns tombstones.
  const usnStart = Number(dse.highestCommittedUSN);
  const usn = await c2.search(
    base,
    {
      scope: 'sub',
      filter: ldaptsFilter(ge('uSNChanged', usnStart)),
      attributes: ['objectGUID', 'isDeleted', 'uSNChanged'],
      explicitBufferAttributes: ['objectGUID'],
    },
    new ShowDeletedControl(),
  );
  const u = usn.searchEntries.find((e) => guidOf(e) === probeGuid);
  result(
    'fallback: (uSNChanged>=start) + Show Deleted sees the tombstone',
    u ? `yes (${String(usn.searchEntries.length)} changed objects)` : 'no',
  );

  await c2.del(container);
  result('cleanup', 'ok');
  await c2.unbind();
  result(
    'ldapts streaming (needed for change notification)',
    'not available: search() resolves only on SearchResultDone, so a notification search never returns entries',
  );

  console.log(`## Spike S2: DirSync with ldapts against ${url}\n\n| check | result |\n|---|---|`);
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
}

await main();
