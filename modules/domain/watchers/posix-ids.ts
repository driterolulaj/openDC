// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POSIX IDs for users and groups created outside OpenDC (ADR-0018, Q22). Runs on the leader; the agent computes
 * idBase + RID and never overwrites. A full resync delivers every object without IDs; only objects created
 * since the handler first ran are filled (existing ones: the "Fill in POSIX IDs" bulk action).
 */
import { isPlatformError } from '@opendc/shared';
import type { WatchHandler } from '@opendc/shared/manifest';

/** "20261025120000.0Z" -> epoch ms */
export function generalizedTime(v: unknown): number | null {
  const s = Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

const handler: WatchHandler = {
  async onChange(batch, ctx) {
    const since = Date.parse(ctx.since);
    for (const e of batch.events) {
      if (e.deleted || !e.guid) continue;
      if (batch.sync) {
        const created = generalizedTime(e.entry.whenCreated);
        if (created === null || created < since) continue;
      }
      try {
        const r = await ctx.agent('directory.posixIds.fill', { guid: e.guid });
        if (r.skipped === null)
          ctx.audit({
            action: 'directory.posix-ids.fill',
            result: 'success',
            targetGuid: e.guid,
            targetDn: r.dn,
            after: r.set,
          });
      } catch (err) {
        // one object with a conflicting ID must not stop the others (and must not quarantine the handler)
        if (!isPlatformError(err) || (err.code !== 'directory.invalid' && err.code !== 'request.not-found')) throw err;
        ctx.log('warn', 'POSIX IDs not filled', { guid: e.guid, code: err.code, error: err.message });
        if (err.code === 'directory.invalid')
          ctx.audit({
            action: 'directory.posix-ids.fill',
            result: 'failure',
            targetGuid: e.guid,
            after: { error: err.message.slice(0, 300) },
          });
      }
    }
  },
};
export default handler;
