// SPDX-License-Identifier: AGPL-3.0-only
/** The watcher's status (ADR-0004): handlers, checkpoints' DC, failures, quarantine, resync counters. */
import { readFile } from 'node:fs/promises';
import { watcherMetrics, watcherStatus, watcherStatusResponse, type WatcherStatus } from '@opendc/shared/api';
import { z } from 'zod';
import type { RouteTable } from '../http/route.ts';

const empty = z.object({});

export function watcherRoutes(t: RouteTable, d: { statusPath: string | null }): void {
  const read = async (): Promise<WatcherStatus | null> => {
    if (!d.statusPath) return null;
    try {
      return watcherStatus.parse(JSON.parse(await readFile(d.statusPath, 'utf8')));
    } catch {
      return null;
    }
  };

  t.add({
    method: 'GET',
    url: '/api/v1/watcher',
    operationId: 'getWatcherStatus',
    summary: "This node's directory watcher: DC, leader, handlers, failures, quarantine, resyncs",
    tags: ['nodes'],
    auth: { permission: 'core.node.info' },
    response: watcherStatusResponse,
    handler: async () => ({ status: await read() }),
  });

  t.add({
    method: 'GET',
    url: '/api/v1/watcher/metrics',
    operationId: 'getWatcherMetrics',
    summary: 'The watcher status in Prometheus text format',
    tags: ['nodes'],
    auth: { permission: 'core.node.info' },
    response: empty,
    stream: true,
    handler: async (c) => {
      const s = await read();
      const raw = c.reply.raw;
      c.reply.hijack();
      raw.writeHead(s ? 200 : 503, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' });
      raw.end(s ? watcherMetrics(s) : '# the watcher has not reported yet\n');
      return {};
    },
  });
}
