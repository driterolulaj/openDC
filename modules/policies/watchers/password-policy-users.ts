// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Users created, moved or changed: their shadow-group memberships follow their effective password policy. A
 * changed OU (renamed, moved: every user below it may now resolve differently) or a full resync reconciles all.
 */
import type { WatchHandler } from '@opendc/shared/manifest';

const MAX_USERS = 5000;

const isOu = (v: unknown): boolean =>
  (Array.isArray(v) ? v : [v]).some((c) => typeof c === 'string' && c.toLowerCase() === 'organizationalunit');

const handler: WatchHandler = {
  async onChange(batch, ctx) {
    const live = batch.events.filter((e) => !e.deleted && e.guid);
    const ous = batch.events.some((e) => isOu(e.entry.objectClass));
    const users = live.filter((e) => !isOu(e.entry.objectClass)).map((e) => e.guid);
    if (batch.sync || ous || users.length > MAX_USERS) {
      const r = await ctx.agent('policy.password.reconcile', {});
      ctx.log('info', 'password policy memberships reconciled', { ...r, full: true });
    } else if (users.length) {
      const r = await ctx.agent('policy.password.reconcile', { users });
      if (r.members.added || r.members.removed) ctx.log('info', 'password policy memberships updated', { ...r });
    }
  },
};
export default handler;
