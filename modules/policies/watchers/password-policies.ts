// SPDX-License-Identifier: AGPL-3.0-only
/** Any change to a policy object: the agent reconciles every password policy (directory-object-model.md §3.2). */
import type { WatchHandler } from '@opendc/shared/manifest';

const handler: WatchHandler = {
  async onChange(_batch, ctx) {
    const r = await ctx.agent('policy.password.reconcile', {});
    ctx.log('info', 'password policies reconciled', { ...r });
  },
};
export default handler;
