// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FSMO transfer/seize and functional level raise (agent-operations.md §3.3, tier 0, typed confirmation).
 * They run on this DC against its local database: a transfer moves roles here from their current holder
 * (which must answer), a seizure takes them without the holder (only when it is gone for good).
 */
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import { fsmoShow, levelShow } from './info.ts';
import type { SambaLocal } from './local.ts';
import type { OsActions } from '@opendc/os';

export async function fsmoTransfer(
  os: OsActions,
  samba: SambaLocal,
  args: OpParsedArgs<'samba.fsmo.transfer'>,
): Promise<OpResult<'samba.fsmo.transfer'>> {
  for (const role of args.roles) {
    // the local DC asks the current owner over DRS, authenticated with its machine account
    await samba.tool(['fsmo', 'transfer', `--role=${role}`, '-H', samba.samDb, '--machine-pass'], {
      timeoutMs: 300_000,
    });
  }
  return fsmoShow(os);
}

export async function fsmoSeize(
  os: OsActions,
  samba: SambaLocal,
  args: OpParsedArgs<'samba.fsmo.seize'>,
): Promise<OpResult<'samba.fsmo.seize'>> {
  for (const role of args.roles) {
    // without --force samba-tool tries a transfer first and only seizes if the owner doesn't answer
    await samba.tool(['fsmo', 'seize', `--role=${role}`, '-H', samba.samDb, ...(args.force ? ['--force'] : [])], {
      timeoutMs: 300_000,
      stdin: 'y\n',
    });
  }
  return fsmoShow(os);
}

export async function levelRaise(
  os: OsActions,
  samba: SambaLocal,
  args: OpParsedArgs<'samba.level.raise'>,
): Promise<OpResult<'samba.level.raise'>> {
  const argv = ['domain', 'level', 'raise', '-H', samba.samDb];
  if (args.domain) argv.push(`--domain-level=${args.domain}`);
  if (args.forest) argv.push(`--forest-level=${args.forest}`);
  await samba.tool(argv, { timeoutMs: 300_000 });
  return levelShow(os);
}
