// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The watcher engine (ADR-0004). Every handler has its own DirSync stream over the domain NC with its own
 * server-side filter and its own checkpoint {DC, invocationId, cookie}:
 * - the checkpoint advances only after the handler succeeded, so a crash replays the batch (handlers are
 *   idempotent);
 * - a checkpoint from another DC, or from the same DC restored from backup (new invocationId), is useless
 *   (USNs and cookies are local to one DC): the stream starts over and the handler gets every matching
 *   object as a `sync` batch (full resync), which is logged and counted;
 * - a failing handler is retried with exponential backoff; after `maxFailures` it is quarantined: its
 *   checkpoint is frozen and the other handlers carry on;
 * - leader handlers run only on the DC that holds the PDC emulator role (ADR-0017).
 * Losing the DC connection is not the handler's fault: the pass ends and nothing counts against it.
 */
import type { Entry } from 'ldapts';
import { guidFromBytes } from '@opendc/shared/ldap';
import type { HandlerState, HandlerStatus, WatcherStatus } from '@opendc/shared/api';
import type { WatchBatch, WatchContext, WatchEvent, WatchHandler } from '@opendc/shared/manifest';

export type { HandlerState, HandlerStatus, WatcherStatus };

export interface WatchedHandler {
  module: string;
  id: string;
  handler: WatchHandler;
  base: string;
  scope: 'base' | 'one' | 'sub';
  filter: string;
  attributes: string[];
  leader?: boolean;
  timeoutMs?: number;
}

export interface DcIdentity {
  /** DN of the DC's NTDS Settings object (rootDSE dsServiceName) */
  dsServiceName: string;
  /** objectGUID-style string of the NTDS Settings invocationId (changes when the DC is restored) */
  invocationId: string;
  dnsHostName: string;
  /** this DC holds the PDC emulator role */
  pdc: boolean;
}

export interface DirectoryPort {
  identity(): Promise<DcIdentity>;
  dirsync(
    nc: string,
    o: { filter: string; attributes: string[]; cookie: Buffer },
  ): Promise<{ entries: Entry[]; cookie: Buffer }>;
}

export interface Checkpoint {
  dc: string;
  invocationId: string;
  /** base64 DirSync cookie; '' = none yet */
  cookie: string;
  failures: number;
  quarantined: boolean;
  lastError: string | null;
  nextAttemptAt: number;
  lastSuccessAt: number | null;
  /** when the handler first ran on this node (kept across resyncs) */
  since: number;
}

export interface CheckpointStore {
  get(handler: string): Checkpoint | null;
  save(handler: string, cp: Checkpoint): void;
}

export interface EngineOptions {
  domainDn: string;
  platformDn: string;
  handlers: WatchedHandler[];
  dir: DirectoryPort;
  state: CheckpointStore;
  context: (h: WatchedHandler, o: { leader: boolean; signal: AbortSignal; since: number }) => WatchContext;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  maxFailures?: number;
  /** first retry delay; doubles per failure up to 5 minutes */
  retryBaseMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
}

/** Attributes every stream asks for, on top of the handler's own. */
export const ALWAYS = ['objectGUID', 'isDeleted', 'lastKnownParent'];

const lower = (s: string): string => s.toLowerCase();
const parentOf = (dn: string): string => dn.slice(dn.search(/(?<!\\),/) + 1);

export class WatcherEngine {
  readonly #o: Required<Omit<EngineOptions, 'now'>> & { now: () => number };
  readonly #counts = new Map<string, { events: number; resyncs: number }>();
  #status: WatcherStatus = {
    updatedAt: new Date(0).toISOString(),
    dc: null,
    leader: false,
    connected: false,
    lastError: null,
    passes: 0,
    handlers: [],
  };

  constructor(o: EngineOptions) {
    this.#o = {
      maxFailures: 5,
      retryBaseMs: 5_000,
      defaultTimeoutMs: 60_000,
      now: () => Date.now(),
      ...o,
    };
  }

  get status(): WatcherStatus {
    return this.#status;
  }

  /** The absolute base DN of a handler. */
  baseOf(h: WatchedHandler): string {
    if (h.base === '{platform}') return this.#o.platformDn;
    if (h.base.startsWith('{platform},')) return `${h.base.slice('{platform},'.length)},${this.#o.platformDn}`;
    return h.base ? `${h.base},${this.#o.domainDn}` : this.#o.domainDn;
  }

  /** Whether an event lies in the handler's base/scope (a deleted object by its last known parent). */
  inScope(h: WatchedHandler, e: WatchEvent): boolean {
    const base = lower(this.baseOf(h));
    if (e.deleted) {
      const lkp = e.entry.lastKnownParent;
      if (typeof lkp !== 'string' || !lkp) return true;
      const p = lower(lkp);
      return h.scope === 'one' ? p === base : h.scope === 'sub' ? p === base || p.endsWith(`,${base}`) : true;
    }
    const dn = lower(e.dn);
    if (h.scope === 'base') return dn === base;
    if (h.scope === 'one') return lower(parentOf(e.dn)) === base;
    return dn === base || dn.endsWith(`,${base}`);
  }

  /** One pass over every handler. */
  async pass(): Promise<WatcherStatus> {
    const o = this.#o;
    let id: DcIdentity;
    try {
      id = await o.dir.identity();
    } catch (e) {
      this.#status = { ...this.#status, connected: false, lastError: msg(e), updatedAt: iso(o.now()) };
      o.log('warn', 'directory not reachable', { error: msg(e) });
      return this.#status;
    }
    const handlers: HandlerStatus[] = [];
    let connected = true;
    let lastError: string | null = null;
    for (const h of o.handlers) {
      if (!connected) {
        handlers.push(this.#describe(h, o.state.get(h.id), 'pending'));
        continue;
      }
      try {
        handlers.push(await this.#run(h, id));
      } catch (e) {
        // the DC went away mid-pass: try again next pass, no fault of the handler
        connected = false;
        lastError = msg(e);
        o.log('warn', 'directory connection lost', { handler: h.id, error: lastError });
        handlers.push(this.#describe(h, o.state.get(h.id), 'pending'));
      }
    }
    this.#status = {
      updatedAt: iso(o.now()),
      dc: id.dnsHostName,
      leader: id.pdc,
      connected,
      lastError,
      passes: this.#status.passes + 1,
      handlers,
    };
    return this.#status;
  }

  async #run(h: WatchedHandler, id: DcIdentity): Promise<HandlerStatus> {
    const o = this.#o;
    const cp = o.state.get(h.id);
    if (cp?.quarantined) return this.#describe(h, cp, 'quarantined');
    if (h.leader && !id.pdc) return this.#describe(h, cp, 'standby');
    if (cp && cp.failures > 0 && o.now() < cp.nextAttemptAt) return this.#describe(h, cp, 'failing');

    const reason = !cp?.cookie
      ? 'no checkpoint'
      : cp.dc !== id.dsServiceName
        ? 'another DC'
        : cp.invocationId !== id.invocationId
          ? 'DC restored (new invocationId)'
          : null;
    const cookie = reason ? Buffer.alloc(0) : Buffer.from(cp?.cookie ?? '', 'base64');
    const since = cp?.since || o.now();
    const fail = (e: unknown): HandlerStatus => {
      const failures = (cp?.failures ?? 0) + 1;
      const quarantined = failures >= o.maxFailures;
      const next: Checkpoint = {
        dc: cp?.dc ?? '',
        invocationId: cp?.invocationId ?? '',
        cookie: cp?.cookie ?? '',
        failures,
        quarantined,
        lastError: msg(e),
        nextAttemptAt: o.now() + Math.min(o.retryBaseMs * 2 ** (failures - 1), 300_000),
        lastSuccessAt: cp?.lastSuccessAt ?? null,
        since,
      };
      o.state.save(h.id, next);
      o.log(quarantined ? 'error' : 'warn', quarantined ? 'handler quarantined' : 'handler failed', {
        handler: h.id,
        failures,
        error: msg(e),
      });
      return this.#describe(h, next, quarantined ? 'quarantined' : 'failing');
    };
    let r: { entries: Entry[]; cookie: Buffer };
    try {
      r = await o.dir.dirsync(o.domainDn, {
        filter: h.filter,
        attributes: [...new Set([...ALWAYS, ...h.attributes])],
        cookie,
      });
    } catch (e) {
      // a lost connection ends the pass (pass() handles it); anything else is this stream's problem
      if (isUnreachable(e)) throw e;
      return fail(e);
    }
    const events = r.entries.map(toEvent).filter((e) => this.inScope(h, e));
    const count = this.#count(h.id);
    if (reason) {
      count.resyncs++;
      o.log(cp?.cookie ? 'warn' : 'info', 'full resync', {
        handler: h.id,
        reason,
        dc: id.dnsHostName,
        objects: events.length,
      });
    }

    if (events.length || reason) {
      const batch: WatchBatch = { handlerId: h.id, sync: reason !== null, events };
      try {
        await this.#invoke(h, batch, id.pdc, since);
      } catch (e) {
        return fail(e);
      }
      count.events += events.length;
    }
    const saved: Checkpoint = {
      dc: id.dsServiceName,
      invocationId: id.invocationId,
      cookie: r.cookie.toString('base64'),
      failures: 0,
      quarantined: false,
      lastError: null,
      nextAttemptAt: 0,
      lastSuccessAt: o.now(),
      since,
    };
    o.state.save(h.id, saved);
    return this.#describe(h, saved, 'ok');
  }

  async #invoke(h: WatchedHandler, batch: WatchBatch, leader: boolean, since: number): Promise<void> {
    const ac = new AbortController();
    const ms = h.timeoutMs ?? this.#o.defaultTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // reject before aborting: a handler that settles on abort must not turn the timeout into a success
        reject(new Error(`timed out after ${String(ms)} ms`));
        ac.abort();
      }, ms);
    });
    try {
      await Promise.race([
        h.handler.onChange(batch, this.#o.context(h, { leader, signal: ac.signal, since })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #count(id: string): { events: number; resyncs: number } {
    let c = this.#counts.get(id);
    if (!c) this.#counts.set(id, (c = { events: 0, resyncs: 0 }));
    return c;
  }

  #describe(h: WatchedHandler, cp: Checkpoint | null, state: HandlerState): HandlerStatus {
    const c = this.#count(h.id);
    return {
      module: h.module,
      id: h.id,
      state,
      dc: cp?.dc || null,
      lastSuccessAt: cp?.lastSuccessAt ? iso(cp.lastSuccessAt) : null,
      lastError: cp?.lastError ?? null,
      failures: cp?.failures ?? 0,
      events: c.events,
      resyncs: c.resyncs,
    };
  }
}

export function toEvent(entry: Entry): WatchEvent {
  const g = entry.objectGUID;
  const guid = Buffer.isBuffer(g) ? guidFromBytes(g) : '';
  const del = entry.isDeleted;
  return { guid, dn: entry.dn, deleted: del === 'TRUE' || (Array.isArray(del) && del[0] === 'TRUE'), entry };
}

const isUnreachable = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ldap.unreachable';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const iso = (ms: number): string => new Date(ms).toISOString();
