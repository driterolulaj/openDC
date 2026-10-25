// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformBootstrap } from './platform.ts';
import type { LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DOMAIN = 'DC=example,DC=test';
const SID = 'S-1-5-21-1-2-3-1105';
const entry = (dn: string, sd: string): LdifEntry => ({ dn, attrs: new Map([['ntsecuritydescriptor', [sd]]]) });

test('watch access: DirSync right on the domain head and read on CN=Deleted Objects, once', async () => {
  let head = 'O:DAG:DAD:AI(A;;RP;;;AU)';
  let deleted = 'O:SYG:SYD:PAI(A;;CCDCLCSWRPWPSDRCWDWO;;;SY)(A;;LCRP;;;BA)S:AI(OU;CIIOIDSA;WP;x;y;WD)';
  const calls: { kind: string; arg: string; controls?: string[] }[] = [];
  const samba = {
    samDb: '/sam.ldb',
    get: (dn: string) => Promise.resolve(dn === DOMAIN ? entry(dn, head) : null),
    getDeleted: (dn: string) => Promise.resolve(entry(dn, deleted)),
    tool: (argv: string[]) => {
      calls.push({ kind: 'dsacl', arg: argv.find((a) => a.startsWith('--sddl=')) ?? '' });
      head += argv.find((a) => a.startsWith('--sddl='))?.slice(7) ?? '';
      return Promise.resolve('');
    },
    modify: (ldif: string, controls: string[]) => {
      calls.push({ kind: 'modify', arg: ldif, controls });
      const sddl = /nTSecurityDescriptor: (.*)/.exec(ldif)?.[1] ?? '';
      deleted = `O:SYG:SY${sddl}`;
      return Promise.resolve();
    },
  } as unknown as SambaLocal;
  const p = new PlatformBootstrap(samba, DOMAIN);
  assert.deepEqual(await p.watchAccess(SID), ['dirsync', 'deleted-objects']);
  assert.match(calls[0]?.arg ?? '', /OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;S-1-5-21-1-2-3-1105/);
  const mod = calls[1];
  assert.deepEqual(mod?.controls, ['show_deleted:1', 'sd_flags:1:4']);
  // the existing ACEs stay, the new one is appended; the SACL is not written (sd_flags 4 = DACL only)
  assert.match(
    mod?.arg ?? '',
    /nTSecurityDescriptor: D:PAI\(A;;CCDCLCSWRPWPSDRCWDWO;;;SY\)\(A;;LCRP;;;BA\)\(A;;LCRP;;;S-1-5-21-1-2-3-1105\)\n/,
  );
  assert.deepEqual(await p.watchAccess(SID), [], 'second run: nothing to do');
  assert.equal(calls.length, 2);
});
