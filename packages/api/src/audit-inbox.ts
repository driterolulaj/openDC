// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The audit inbox (ADR-0013): services without access to the audit DB (the watcher) drop one JSON file per
 * entry into a directory only they and the API can reach (0730 api:watch). The API appends each entry to the
 * hash-chained log under the dropping service's name and deletes the file. Dot files are still being written.
 */
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuditLog } from './audit.ts';

const MAX_BYTES = 64 * 1024;
const MAX_PER_RUN = 1000;

const inboxEntry = z.strictObject({
  ts: z.string().max(40),
  actor: z.string().regex(/^opendc-[a-z]+@[A-Za-z0-9.-]{1,253}$/),
  action: z.string().regex(/^[a-z][a-z0-9.-]{1,99}$/),
  result: z.enum(['success', 'failure']),
  // AD objectGUIDs don't follow the RFC 4122 version rules that z.uuid() checks
  targetGuid: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  targetDn: z.string().max(2048).optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export function ingestInbox(
  dir: string,
  audit: Pick<AuditLog, 'append'>,
  log: (level: 'warn' | 'info', msg: string, extra: Record<string, unknown>) => void,
): number {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => !n.startsWith('.') && n.endsWith('.json'))
      .sort()
      .slice(0, MAX_PER_RUN);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_BYTES) throw new Error(st.isFile() ? 'too large' : 'not a regular file');
      const e = inboxEntry.parse(JSON.parse(readFileSync(path, 'utf8')));
      audit.append({
        actor: e.actor,
        action: e.action,
        result: e.result,
        targetGuid: e.targetGuid ?? null,
        targetDn: e.targetDn ?? null,
        before: e.before ?? null,
        after: e.after ?? null,
      });
      n++;
    } catch (err) {
      log('warn', 'audit inbox entry dropped', {
        file: name,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  return n;
}
