// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POSIX IDs for users and groups created outside OpenDC (ADR-0018, Q22). Runs on the leader; the agent computes
 * idBase + RID and never overwrites. A full resync delivers every object without IDs; only objects created
 * since the handler first ran are filled (existing ones: the "Fill in POSIX IDs" bulk action).
 */
import type { WatchHandler } from '@opendc/shared/manifest';

const BATCH = 500;

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
    const guids = batch.events
      .filter((e) => {
        if (e.deleted || !e.guid) return false;
        if (!batch.sync) return true;
        const created = generalizedTime(e.entry.whenCreated);
        return created !== null && created >= since;
      })
      .map((e) => e.guid);
    for (let i = 0; i < guids.length; i += BATCH) {
      // agent errors (unreachable, timeout) fail the batch and it is retried; per-object problems don't
      const { results } = await ctx.agent('directory.posixIds.fill', { guids: guids.slice(i, i + BATCH) });
      for (const r of results) {
        if (r.error === 'not found') continue; // deleted meanwhile
        if (r.error) {
          ctx.log('warn', 'POSIX IDs not filled', { guid: r.guid, dn: r.dn, error: r.error });
          ctx.audit({
            action: 'directory.posix-ids.fill',
            result: 'failure',
            targetGuid: r.guid,
            ...(r.dn ? { targetDn: r.dn } : {}),
            after: { error: r.error },
          });
        } else if (r.skipped === null && r.dn)
          ctx.audit({
            action: 'directory.posix-ids.fill',
            result: 'success',
            targetGuid: r.guid,
            targetDn: r.dn,
            after: r.set,
          });
      }
    }
  },
};
export default handler;
