// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Append-only audit log with a per-origin hash chain (ADR-0013 §2). Triggers reject UPDATE/DELETE; the chain
 * makes silent edits of the file detectable (`verify`). Diffs are redacted before they are stored.
 */
import { createHash } from 'node:crypto';
import { PlatformError } from '@opendc/shared';
import { canonicalJson } from '@opendc/shared/agent';
import type { PlatformDb } from '@opendc/shared/db';

export interface AuditInput {
  actor: string;
  actorSid?: string | null;
  sourceIp?: string | null;
  action: string;
  result: 'success' | 'failure' | 'denied';
  targetGuid?: string | null;
  targetDn?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

export interface AuditEntry {
  originNodeId: string;
  seq: number;
  ts: string;
  actor: string;
  actorSid: string | null;
  sourceIp: string | null;
  action: string;
  result: string;
  targetGuid: string | null;
  targetDn: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const SECRET_KEY = /pass(word)?|pwd|secret|token|credential|private|unicodePwd|key$/i;

/** Removes secret-looking fields at any depth (SECURITY.md: no secrets in audit diffs). */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(x)]));
  }
  return v;
}

function entryHash(prevHash: string, e: Omit<AuditEntry, 'hash' | 'prevHash'>): string {
  return createHash('sha256')
    .update(prevHash)
    .update(
      canonicalJson({
        originNodeId: e.originNodeId,
        seq: e.seq,
        ts: e.ts,
        actor: e.actor,
        actorSid: e.actorSid,
        sourceIp: e.sourceIp,
        action: e.action,
        result: e.result,
        targetGuid: e.targetGuid,
        targetDn: e.targetDn,
        before: e.before ?? null,
        after: e.after ?? null,
        requestId: e.requestId,
      }),
    )
    .digest('hex');
}

interface Row {
  origin_node_id: string;
  seq: number;
  ts: string;
  actor: string;
  actor_sid: string | null;
  source_ip: string | null;
  action: string;
  result: string;
  target_guid: string | null;
  target_dn: string | null;
  before_json: string | null;
  after_json: string | null;
  request_id: string | null;
  prev_hash: string;
  hash: string;
}

const fromRow = (r: Row): AuditEntry => ({
  originNodeId: r.origin_node_id,
  seq: r.seq,
  ts: r.ts,
  actor: r.actor,
  actorSid: r.actor_sid,
  sourceIp: r.source_ip,
  action: r.action,
  result: r.result,
  targetGuid: r.target_guid,
  targetDn: r.target_dn,
  before: r.before_json === null ? null : (JSON.parse(r.before_json) as unknown),
  after: r.after_json === null ? null : (JSON.parse(r.after_json) as unknown),
  requestId: r.request_id,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export class AuditLog {
  readonly #db: PlatformDb;
  readonly #origin: string;
  readonly #now: () => Date;

  constructor(db: PlatformDb, originNodeId: string, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#origin = originNodeId;
    this.#now = now;
  }

  append(input: AuditInput): AuditEntry {
    return this.#db.transaction(() => {
      const last = this.#db.get<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM audit WHERE origin_node_id = ? ORDER BY seq DESC LIMIT 1',
        [this.#origin],
      );
      const base = {
        originNodeId: this.#origin,
        seq: (last?.seq ?? 0) + 1,
        ts: this.#now().toISOString(),
        actor: input.actor,
        actorSid: input.actorSid ?? null,
        sourceIp: input.sourceIp ?? null,
        action: input.action,
        result: input.result,
        targetGuid: input.targetGuid ?? null,
        targetDn: input.targetDn ?? null,
        before: input.before === undefined ? null : redact(input.before),
        after: input.after === undefined ? null : redact(input.after),
        requestId: input.requestId ?? null,
      };
      const prevHash = last?.hash ?? GENESIS;
      const hash = entryHash(prevHash, base);
      this.#db.run(
        `INSERT INTO audit (origin_node_id, seq, ts, actor, actor_sid, source_ip, action, result, target_guid, target_dn,
                            before_json, after_json, request_id, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          base.originNodeId,
          base.seq,
          base.ts,
          base.actor,
          base.actorSid,
          base.sourceIp,
          base.action,
          base.result,
          base.targetGuid,
          base.targetDn,
          base.before === null ? null : JSON.stringify(base.before),
          base.after === null ? null : JSON.stringify(base.after),
          base.requestId,
          prevHash,
          hash,
        ],
      );
      return { ...base, prevHash, hash };
    });
  }

  list(opts: { limit?: number; beforeTs?: string; targetGuid?: string; actorSid?: string } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.beforeTs) {
      where.push('ts < ?');
      params.push(opts.beforeTs);
    }
    if (opts.targetGuid) {
      where.push('target_guid = ?');
      params.push(opts.targetGuid);
    }
    if (opts.actorSid) {
      where.push('actor_sid = ?');
      params.push(opts.actorSid);
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
    return this.#db
      .all<Row>(
        `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, seq DESC LIMIT ?`,
        params,
      )
      .map(fromRow);
  }

  /** Recomputes the chain of one origin; throws audit.chain-broken at the first mismatch. */
  verify(origin = this.#origin, path = '(platform db)'): number {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.#db.all<Row>('SELECT * FROM audit WHERE origin_node_id = ? ORDER BY seq', [origin])) {
      const e = fromRow(r);
      if (e.seq !== n + 1 || e.prevHash !== prev || entryHash(prev, e) !== e.hash) {
        throw new PlatformError('audit.chain-broken', { origin, seq: e.seq, path });
      }
      prev = e.hash;
      n++;
    }
    return n;
  }
}
