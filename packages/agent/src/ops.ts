// SPDX-License-Identifier: AGPL-3.0-only
/** Implementations of the Phase 1 operations. Each one does exactly what its catalogue entry says. */
import { randomBytes } from 'node:crypto';
import { PlatformError, platformVersion } from '@opendc/shared';
import type { ImplementedOp, OpArgs, OpResult } from '@opendc/shared/agent';
import type { AgentSocket, NodeRole } from '@opendc/shared/manifest';
import type { OsActions } from '@opendc/os';
import type { Allowlist } from './allowlist.ts';

export interface OpContext {
  os: OsActions;
  allowlist: Allowlist;
  socket: AgentSocket;
  requestId: string;
  role: NodeRole;
  locks: CommitLock;
}

/** Timeouts per op (ms). */
export const timeouts: Partial<Record<ImplementedOp, number>> = {
  'service.start': 90_000,
  'service.stop': 90_000,
  'service.restart': 90_000,
  'service.reload': 90_000,
};

/** In-memory registry commit lock. Registry commits are short; a holder that vanished expires. */
export class CommitLock {
  #held: { token: string; holder: string; since: Date; expires: number } | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  acquire(holder: string, ttlSec: number): OpResult<'registry.commitLock'> {
    const now = this.#now();
    if (this.#held && this.#held.expires > now) {
      return { acquired: false, heldBy: this.#held.holder, since: this.#held.since.toISOString() };
    }
    const token = randomBytes(16).toString('hex');
    this.#held = { token, holder, since: new Date(now), expires: now + ttlSec * 1000 };
    return { acquired: true, token };
  }

  release(token: string): OpResult<'registry.commitLock'> {
    if (this.#held?.token !== token) return { acquired: false };
    this.#held = null;
    return { acquired: false };
  }
}

type Impl<O extends ImplementedOp> = (args: OpArgs<O>, ctx: OpContext) => Promise<OpResult<O>>;
type Impls = { [O in ImplementedOp]: Impl<O> };

const owner = (o: 'root' | 'service', fileId: string, ctx: OpContext): { uid: number; gid: number } => {
  if (o === 'root') return { uid: 0, gid: 0 };
  throw new PlatformError('agent.op-failed', { op: 'file.writeManaged', reason: `owner "service" for ${fileId} is not supported before Phase 2`, requestId: ctx.requestId });
};

type ServiceOp = 'service.start' | 'service.stop' | 'service.restart' | 'service.reload';

function serviceOp<O extends ServiceOp>(verb: 'start' | 'stop' | 'restart' | 'reload'): Impl<O> {
  return async (args, ctx) => {
    const { unit } = args as { unit: string };
    ctx.allowlist.unit(unit, verb, ctx.socket, `service.${verb}`);
    await ctx.os.services[verb](unit);
    return { unit } as OpResult<O>;
  };
}

export const implementations: Impls = {
  'system.info': async (_args, ctx) => {
    const i = await ctx.os.system.info();
    const r = ctx.os.facts.release;
    return { ...i, os: { id: r.id, versionId: r.versionId, prettyName: r.prettyName, adapter: ctx.os.facts.adapter }, role: ctx.role, agentVersion: platformVersion };
  },
  'samba.version': async (_args, ctx) => {
    const v = await ctx.os.facts.samba.version();
    return v ? { raw: v.raw, major: v.major, minor: v.minor, patch: v.patch } : null;
  },
  'service.status': async (args, ctx) => {
    ctx.allowlist.unit(args.unit, 'status', ctx.socket, 'service.status');
    return { unit: args.unit, ...(await ctx.os.services.status(args.unit)) };
  },
  'service.start': serviceOp('start'),
  'service.stop': serviceOp('stop'),
  'service.restart': serviceOp('restart'),
  'service.reload': serviceOp('reload'),
  'file.writeManaged': async (args, ctx) => {
    const f = ctx.allowlist.file(args.fileId, ctx.socket, 'file.writeManaged');
    const path = ctx.os.facts.paths.managedFile(f.pathKey);
    if (args.expectedPrevSha256 !== undefined) {
      const cur = await ctx.os.files.readManaged(path);
      const actual = cur?.sha256 ?? null;
      if (actual !== args.expectedPrevSha256) {
        throw new PlatformError('agent.stale-file', { fileId: args.fileId, expected: args.expectedPrevSha256 ?? 'absent', actual: actual ?? 'absent' });
      }
    }
    return ctx.os.files.writeManaged(path, args.content, owner(f.owner, args.fileId, ctx), f.mode);
  },
  'file.readManaged': async (args, ctx) => {
    const f = ctx.allowlist.file(args.fileId, ctx.socket, 'file.readManaged');
    const r = await ctx.os.files.readManaged(ctx.os.facts.paths.managedFile(f.pathKey));
    return { content: r?.content ?? null, sha256: r?.sha256 ?? null };
  },
  'file.restorePrevious': async (args, ctx) => {
    const f = ctx.allowlist.file(args.fileId, ctx.socket, 'file.restorePrevious');
    return ctx.os.files.restorePrevious(ctx.os.facts.paths.managedFile(f.pathKey));
  },
  'registry.commitLock': async (args, ctx) =>
    Promise.resolve(args.action === 'acquire' ? ctx.locks.acquire(args.holder, args.ttlSec) : ctx.locks.release(args.token)),
};

/** Arguments summarised for the log: never file contents, tokens or confirmation material. */
export function summarize(op: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;
  if (op === 'file.writeManaged') {
    return { fileId: a.fileId, bytes: typeof a.content === 'string' ? Buffer.byteLength(a.content) : undefined, expectedPrevSha256: a.expectedPrevSha256 };
  }
  if (op === 'registry.commitLock') return { action: a.action, holder: a.holder };
  return a;
}
