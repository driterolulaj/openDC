// SPDX-License-Identifier: AGPL-3.0-only
/** The watcher's status snapshot (ADR-0004), written by the watcher and served by the API. Browser-safe. */
import { z } from 'zod';

export const watcherHandlerStatus = z.object({
  module: z.string(),
  id: z.string(),
  state: z.enum(['ok', 'failing', 'quarantined', 'standby', 'pending']),
  dc: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  failures: z.number(),
  events: z.number(),
  resyncs: z.number(),
});
export type HandlerStatus = z.infer<typeof watcherHandlerStatus>;
export type HandlerState = HandlerStatus['state'];

export const watcherStatus = z.object({
  updatedAt: z.string(),
  dc: z.string().nullable(),
  leader: z.boolean(),
  connected: z.boolean(),
  lastError: z.string().nullable(),
  passes: z.number(),
  handlers: z.array(watcherHandlerStatus),
});
export type WatcherStatus = z.infer<typeof watcherStatus>;

/** null: the watcher hasn't written a status yet (not running, or the node isn't set up). */
export const watcherStatusResponse = z.object({ status: watcherStatus.nullable() });

/** Prometheus text exposition of a status snapshot. */
export function watcherMetrics(s: WatcherStatus): string {
  const label = (id: string): string => id.replace(/["\\n]/g, '_');
  const per = (name: string, v: (h: HandlerStatus) => number): string[] =>
    s.handlers.map((h) => `${name}{handler="${label(h.id)}"} ${String(v(h))}`);
  return (
    [
      '# HELP opendc_watcher_connected Whether the watcher reached its DC in the last pass.',
      '# TYPE opendc_watcher_connected gauge',
      `opendc_watcher_connected ${s.connected ? 1 : 0}`,
      '# HELP opendc_watcher_passes_total Watcher passes since start.',
      '# TYPE opendc_watcher_passes_total counter',
      `opendc_watcher_passes_total ${String(s.passes)}`,
      '# HELP opendc_watcher_events_total Directory changes delivered to a handler.',
      '# TYPE opendc_watcher_events_total counter',
      ...per('opendc_watcher_events_total', (h) => h.events),
      '# HELP opendc_watcher_resyncs_total Full resyncs (no checkpoint, other DC, restored DC).',
      '# TYPE opendc_watcher_resyncs_total counter',
      ...per('opendc_watcher_resyncs_total', (h) => h.resyncs),
      '# HELP opendc_watcher_handler_failures Consecutive failures of a handler.',
      '# TYPE opendc_watcher_handler_failures gauge',
      ...per('opendc_watcher_handler_failures', (h) => h.failures),
      '# HELP opendc_watcher_handler_quarantined Whether a handler is quarantined.',
      '# TYPE opendc_watcher_handler_quarantined gauge',
      ...per('opendc_watcher_handler_quarantined', (h) => (h.state === 'quarantined' ? 1 : 0)),
    ].join('\n') + '\n'
  );
}
