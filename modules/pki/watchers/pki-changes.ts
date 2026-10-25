// SPDX-License-Identifier: AGPL-3.0-only
/** Anything changed under CN=PKI: this DC's PKI maintenance is idempotent, so it simply runs (ADR-0007). */
import type { WatchHandler } from '@opendc/shared/manifest';

const handler: WatchHandler = {
  async onChange(_batch, ctx) {
    const r = await ctx.agent('pki.maintain', {});
    if (r.crl || r.leafs.some((l) => l.renewed) || r.state !== 'ready')
      ctx.log('info', 'pki maintenance', {
        state: r.state,
        crl: r.crl,
        renewed: r.leafs.filter((l) => l.renewed).map((l) => l.profile),
      });
  },
};
export default handler;
