// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The contract between the watcher and module handlers (ADR-0004). A handler is a "what should be" reconciler:
 * it gets the objects that changed (or, after a full resync, every matching object) and recomputes its output
 * from current directory state. It must be idempotent: a batch can be delivered again after a crash.
 */
import type { Entry } from 'ldapts';
import type { ImplementedOp, OpArgs, OpResult } from '../agent/ops.ts';
import type { LdapFilter } from '../ldap/filter.ts';
import type { NodeRole } from './schema.ts';

export interface WatchEvent {
  guid: string;
  /** Current DN; a deleted object's tombstone DN lies under CN=Deleted Objects. */
  dn: string;
  deleted: boolean;
  /** The attributes DirSync returned (changed ones plus a few always-present ones), not the whole object. */
  entry: Entry;
}

export interface WatchBatch {
  handlerId: string;
  /** true for a full resync: `events` holds every matching object, not only changes. */
  sync: boolean;
  events: WatchEvent[];
}

/** What a handler may do. Writes go through typed agent operations; the watcher's LDAP account is read-only. */
export interface WatchContext {
  readonly domainDn: string;
  /** CN=OpenDC,CN=System,<domainDn> */
  readonly platformDn: string;
  readonly node: { hostname: string; fqdn: string; role: NodeRole | 'unprovisioned' };
  /** True on the DC that holds the PDC emulator role (ADR-0017). */
  readonly leader: boolean;
  /**
   * When this handler first ran on this node (ISO-8601). A full resync delivers every matching object; a
   * handler that should act only on objects created from now on compares their whenCreated with this.
   */
  readonly since: string;
  readonly ldap: {
    search(
      base: string,
      o: { scope: 'base' | 'one' | 'sub'; filter?: LdapFilter; attributes: string[]; buffers?: string[] },
    ): Promise<Entry[]>;
  };
  agent<O extends ImplementedOp>(op: O, args: OpArgs<O>): Promise<OpResult<O>>;
  /** This node's Config Registry: replace the domain-policy layer (re-renders affected files). */
  readonly registry: { applyPolicyLayer(values: Record<string, unknown>): Promise<{ changed: string[] } | null> };
  /** One audit entry (actor: the watcher of this node); delivered to the console's audit log. */
  audit(e: {
    action: string;
    result: 'success' | 'failure';
    targetGuid?: string;
    targetDn?: string;
    before?: unknown;
    after?: unknown;
  }): void;
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void;
  /** Aborted when the handler's time is up. */
  readonly signal: AbortSignal;
}

export interface WatchHandler {
  onChange(batch: WatchBatch, ctx: WatchContext): Promise<void>;
}
