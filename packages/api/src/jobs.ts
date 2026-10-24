// SPDX-License-Identifier: AGPL-3.0-only
/** In-process jobs with persisted progress events, streamed to the console over SSE (ADR-0011 §5). */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PlatformError, isPlatformError } from '@opendc/shared';
import type { PlatformDb } from '@opendc/shared/db';

export interface JobEvent {
  n: number;
  ts: string;
  kind: 'progress' | 'done' | 'failed';
  data: unknown;
}

export interface Job {
  id: string;
  type: string;
  actor: string;
  actorSid: string | null;
  status: 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  result: unknown;
  error: unknown;
}

interface JobRow {
  id: string;
  type: string;
  actor: string;
  actor_sid: string | null;
  status: Job['status'];
  created_at: string;
  updated_at: string;
  result_json: string | null;
  error_json: string | null;
}

export type ProgressFn = (p: { step: string; percent?: number; line?: string }) => void;

export class JobRunner {
  readonly #db: PlatformDb;
  readonly #bus = new EventEmitter();

  constructor(db: PlatformDb) {
    this.#db = db;
    this.#bus.setMaxListeners(1000);
  }

  start(type: string, actor: { name: string; sid: string | null }, fn: (progress: ProgressFn) => Promise<unknown>): Job {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.run('INSERT INTO jobs (id, type, actor, actor_sid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, type, actor.name, actor.sid, 'running', now, now]);
    let n = 0;
    const emit = (kind: JobEvent['kind'], data: unknown): void => {
      const ev: JobEvent = { n: ++n, ts: new Date().toISOString(), kind, data };
      this.#db.run('INSERT INTO job_events (job_id, n, ts, kind, data_json) VALUES (?, ?, ?, ?, ?)', [id, ev.n, ev.ts, kind, JSON.stringify(data)]);
      this.#bus.emit(id, ev);
    };
    void (async () => {
      try {
        const result = await fn((p) => {
          emit('progress', p);
        });
        this.#db.run('UPDATE jobs SET status = ?, updated_at = ?, result_json = ? WHERE id = ?', ['succeeded', new Date().toISOString(), JSON.stringify(result ?? null), id]);
        emit('done', result ?? null);
      } catch (e) {
        const body = (isPlatformError(e) ? e : new PlatformError('internal', { requestId: id }, { cause: e })).toBody();
        this.#db.run('UPDATE jobs SET status = ?, updated_at = ?, error_json = ? WHERE id = ?', ['failed', new Date().toISOString(), JSON.stringify(body), id]);
        emit('failed', body);
      }
    })();
    return this.get(id) as Job;
  }

  get(id: string): Job | null {
    const r = this.#db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!r) return null;
    return {
      id: r.id,
      type: r.type,
      actor: r.actor,
      actorSid: r.actor_sid,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
      error: r.error_json === null ? null : (JSON.parse(r.error_json) as unknown),
    };
  }

  events(id: string, afterN = 0): JobEvent[] {
    return this.#db
      .all<{ n: number; ts: string; kind: JobEvent['kind']; data_json: string }>('SELECT n, ts, kind, data_json FROM job_events WHERE job_id = ? AND n > ? ORDER BY n', [id, afterN])
      .map((r) => ({ n: r.n, ts: r.ts, kind: r.kind, data: JSON.parse(r.data_json) as unknown }));
  }

  subscribe(id: string, fn: (ev: JobEvent) => void): () => void {
    this.#bus.on(id, fn);
    return () => this.#bus.off(id, fn);
  }
}
