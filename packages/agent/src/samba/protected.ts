// SPDX-License-Identifier: AGPL-3.0-only
/**
 * samba.protectedObject.modify (agent-operations.md §3.3): changes to tier-0 objects, which the delegated API
 * account can't write (SDProp blocks it). Runs against the local sam.ldb as the DC itself, after the API
 * checked a tier-0 role and the user typed the confirmation. Only the typed changes below are possible; a
 * membership change is followed by SDProp so new members of protected groups are protected right away.
 */
import { PlatformError } from '@opendc/shared';
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import { guidBase } from '@opendc/shared/ldap';
import { first, modifyRecord, unicodePwd, type Mod } from './ldif.ts';
import type { SambaLocal } from './local.ts';
import { runSdPropIfPdc } from './sdprop.ts';

const UF_ACCOUNTDISABLE = 0x2;

export async function modifyProtected(
  samba: SambaLocal,
  args: OpParsedArgs<'samba.protectedObject.modify'>,
  hostname: string,
): Promise<OpResult<'samba.protectedObject.modify'>> {
  const target = await samba.get(guidBase(args.targetGuid), ['userAccountControl', 'objectClass']);
  if (!target) throw new PlatformError('request.not-found', { what: `Object ${args.targetGuid}` });
  const dn = target.dn;
  const c = args.change;
  const mods: Mod[] = [];
  let membership = false;
  switch (c.kind) {
    case 'password':
      mods.push({ op: 'replace', attr: 'unicodePwd', values: [unicodePwd(c.password)] });
      if (c.mustChange) mods.push({ op: 'replace', attr: 'pwdLastSet', values: ['0'] });
      if (c.unlock) mods.push({ op: 'replace', attr: 'lockoutTime', values: ['0'] });
      break;
    case 'enable':
    case 'disable': {
      const uac = Number(first(target, 'userAccountControl') ?? '512');
      const next = c.kind === 'enable' ? uac & ~UF_ACCOUNTDISABLE : uac | UF_ACCOUNTDISABLE;
      mods.push({ op: 'replace', attr: 'userAccountControl', values: [String(next)] });
      break;
    }
    case 'unlock':
      mods.push({ op: 'replace', attr: 'lockoutTime', values: ['0'] });
      break;
    case 'memberAdd':
    case 'memberRemove': {
      const members: string[] = [];
      for (const g of c.memberGuids) {
        const m = await samba.get(guidBase(g), ['objectClass']);
        if (!m) throw new PlatformError('request.not-found', { what: `Object ${g}` });
        members.push(m.dn);
      }
      mods.push({ op: c.kind === 'memberAdd' ? 'add' : 'delete', attr: 'member', values: members });
      membership = true;
      break;
    }
    case 'attributes':
      for (const [attr, value] of Object.entries(c.values)) {
        mods.push({ op: 'replace', attr, values: value === null ? [] : [value] });
      }
      break;
  }
  if (mods.length) await samba.modify(modifyRecord(dn, mods));
  const sdprop = membership ? (await runSdPropIfPdc(samba, hostname)).updated.length : 0;
  return { dn, sdprop };
}
