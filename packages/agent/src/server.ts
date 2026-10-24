// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Request handling for one agent socket. Order of checks for every request:
 * frame size -> JSON -> JSON-RPC shape -> socket allowlist -> op version -> strict args -> resources
 * (inside the op) -> confirmation (typed ops) -> timeout. Every request is logged once.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { PlatformError, isPlatformError, type ErrorBody } from '@opendc/shared';
import {
  FrameReader,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_SERVER_ERROR,
  catalogue,
  errorResponse,
  isCatalogued,
  ops,
  requestSchema,
  resultResponse,
  verifyConfirmation,
  type AgentRequest,
} from '@opendc/shared/agent';
import type { AgentSocket, NodeRole } from '@opendc/shared/manifest';
import type { OsActions } from '@opendc/os';
import type { Allowlist } from './allowlist.ts';
import { CommitLock, implementations, summarize, timeouts, type OpContext } from './ops.ts';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  [k: string]: unknown;
}

export interface AgentDeps {
  os: OsActions;
  allowlist: Allowlist;
  role: NodeRole;
  /** HMAC key for typed confirmations (systemd credential). */
  confirmKey: Buffer | null;
  log: (line: LogLine) => void;
  locks?: CommitLock;
}

const MAX_CONNECTIONS = 64;

export class AgentServer {
  readonly #deps: AgentDeps;
  readonly #locks: CommitLock;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    this.#locks = deps.locks ?? new CommitLock();
  }

  /** A net.Server bound to nothing yet; the caller listens on a path or an inherited fd. */
  createServer(socket: AgentSocket): Server {
    const server = createServer({ allowHalfOpen: false }, (conn) => {
      this.#handle(socket, conn);
    });
    server.maxConnections = MAX_CONNECTIONS;
    return server;
  }

  #handle(socket: AgentSocket, conn: Socket): void {
    conn.setTimeout(10 * 60_000, () => conn.destroy());
    const reader = new FrameReader(
      (line) => {
        void this.handleFrame(socket, line).then((out) => {
          if (!conn.destroyed) conn.write(out);
        });
      },
      () => {
        const body = new PlatformError('agent.protocol', { reason: 'frame larger than 4 MiB' }).toBody();
        this.#deps.log({ level: 'warn', msg: 'frame too large', socket });
        conn.end(errorResponse(null, RPC_INVALID_REQUEST, body));
      },
    );
    conn.on('data', (chunk: Buffer) => {
      reader.push(chunk);
    });
    conn.on('error', () => undefined);
  }

  /** Handles one frame and returns the response frame. Exposed for tests. */
  async handleFrame(socket: AgentSocket, line: string): Promise<string> {
    const started = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.#fail(null, socket, '-', RPC_INVALID_REQUEST, new PlatformError('agent.protocol', { reason: 'invalid JSON' }), started);
    }
    const req = requestSchema.safeParse(parsed);
    if (!req.success) {
      const id = typeof (parsed as { id?: unknown } | null)?.id === 'string' ? (parsed as { id: string }).id : null;
      return this.#fail(id, socket, '-', RPC_INVALID_REQUEST, new PlatformError('agent.protocol', { reason: req.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }), started);
    }
    const r: AgentRequest = req.data;
    try {
      const result = await this.#dispatch(socket, r);
      this.#deps.log({
        level: 'info',
        msg: 'op ok',
        requestId: r.id,
        op: r.method,
        socket,
        actor: r.params.actor,
        args: summarize(r.method, r.params.args),
        durationMs: Date.now() - started,
      });
      return resultResponse(r.id, result);
    } catch (e) {
      const code = isPlatformError(e)
        ? e.code === 'agent.unknown-op' || e.code === 'agent.op-not-allowed'
          ? RPC_METHOD_NOT_FOUND
          : e.code === 'agent.invalid-args'
            ? RPC_INVALID_PARAMS
            : RPC_SERVER_ERROR
        : RPC_SERVER_ERROR;
      return this.#fail(r.id, socket, r.method, code, e, started, r);
    }
  }

  async #dispatch(socket: AgentSocket, r: AgentRequest): Promise<unknown> {
    const { method, params } = r;
    if (!isCatalogued(method)) throw new PlatformError('agent.unknown-op', { op: method, version: params.v });
    const op = this.#deps.allowlist.op(socket, method);
    const def = ops[op];
    if (params.v !== def.v) throw new PlatformError('agent.unknown-op', { op: method, version: params.v });
    const args = def.args.safeParse(params.args);
    if (!args.success) {
      throw new PlatformError('agent.invalid-args', { op: method, issues: args.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ') });
    }
    const entry = catalogue[op] as { confirm?: 'typed' };
    if (entry.confirm === 'typed') {
      if (!params.confirmation) throw new PlatformError('agent.confirmation-required', { op });
      const key = this.#deps.confirmKey;
      const check = key ? verifyConfirmation(key, params.confirmation, { op, args: args.data, actor: params.actor.sid ?? params.actor.name }) : { ok: false as const };
      if (!check.ok) throw new PlatformError('agent.confirmation-invalid', { op, ttlSec: 120 });
    }
    const ctx: OpContext = { os: this.#deps.os, allowlist: this.#deps.allowlist, socket, requestId: r.id, role: this.#deps.role, locks: this.#locks };
    const timeoutMs = timeouts[op] ?? 60_000;
    const impl = implementations[op] as (a: unknown, c: OpContext) => Promise<unknown>;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        impl(args.data, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new PlatformError('agent.timeout', { op, timeoutMs, requestId: r.id }));
          }, timeoutMs);
        }),
      ]);
      return def.result.parse(result);
    } finally {
      clearTimeout(timer);
    }
  }

  #fail(id: string | null, socket: AgentSocket, op: string, rpcCode: number, e: unknown, started: number, r?: AgentRequest): string {
    const body: ErrorBody = isPlatformError(e)
      ? e.toBody()
      : new PlatformError('agent.op-failed', { op, reason: e instanceof Error ? e.message : String(e), requestId: id ?? '-' }).toBody();
    this.#deps.log({
      level: isPlatformError(e) && (e.code === 'agent.op-not-allowed' || e.code === 'agent.confirmation-invalid') ? 'warn' : 'error',
      msg: 'op failed',
      requestId: id,
      op,
      socket,
      ...(r ? { actor: r.params.actor, args: summarize(r.method, r.params.args) } : {}),
      code: body.code,
      error: body.message,
      durationMs: Date.now() - started,
    });
    return errorResponse(id, rpcCode, body);
  }
}
