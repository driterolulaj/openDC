// SPDX-License-Identifier: AGPL-3.0-only
/** Client for the agent's Unix sockets. One connection per call keeps failure handling simple. */
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PlatformError, isErrorCode } from '../errors.ts';
import { FrameReader, progressSchema, responseSchema, type Actor, type Progress } from './protocol.ts';
import { ops, type ImplementedOp, type OpArgs, type OpResult } from './ops.ts';
import type { AgentSocket } from '../manifest/schema.ts';

export interface CallOptions {
  actor: Actor;
  timeoutMs?: number;
  idempotencyKey?: string;
  confirmation?: string;
  setupToken?: string;
  onProgress?: (p: Progress) => void;
}

export class AgentClient {
  readonly socketPath: string;
  readonly socket: AgentSocket;

  constructor(socketPath: string, socket: AgentSocket) {
    this.socketPath = socketPath;
    this.socket = socket;
  }

  async call<O extends ImplementedOp>(op: O, args: OpArgs<O>, opts: CallOptions): Promise<OpResult<O>> {
    const id = randomUUID();
    const def = ops[op];
    const request = {
      jsonrpc: '2.0',
      id,
      method: op,
      params: {
        v: def.v,
        args,
        actor: opts.actor,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        ...(opts.confirmation ? { confirmation: opts.confirmation } : {}),
        ...(opts.setupToken ? { setupToken: opts.setupToken } : {}),
      },
    };
    const raw = await this.#roundTrip(id, op, JSON.stringify(request) + '\n', opts);
    return def.result.parse(raw) as OpResult<O>;
  }

  #roundTrip(id: string, op: string, frame: string, opts: CallOptions): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(() => {
        done(() => {
          reject(new PlatformError('agent.timeout', { op, timeoutMs, requestId: id }));
        });
      }, timeoutMs);

      const reader = new FrameReader(
        (line) => {
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            done(() => {
              reject(new PlatformError('agent.protocol', { reason: 'agent sent invalid JSON' }));
            });
            return;
          }
          const progress = progressSchema.safeParse(msg);
          if (progress.success) {
            if (progress.data.params.id === id) opts.onProgress?.(progress.data.params);
            return;
          }
          const res = responseSchema.safeParse(msg);
          if (!res.success) {
            done(() => {
              reject(new PlatformError('agent.protocol', { reason: 'unexpected agent message' }));
            });
            return;
          }
          const r = res.data;
          if ('result' in r) {
            done(() => {
              resolve(r.result);
            });
          } else {
            const data = r.error.data;
            done(() => {
              reject(
                isErrorCode(data.code)
                  ? new PlatformError(data.code, data.params)
                  : new PlatformError('internal', { requestId: id }),
              );
            });
          }
        },
        () => {
          done(() => {
            reject(new PlatformError('agent.protocol', { reason: 'agent response frame too large' }));
          });
        },
      );

      sock.on('data', (chunk: Buffer) => {
        reader.push(chunk);
      });
      sock.on('error', (err: NodeJS.ErrnoException) => {
        done(() => {
          reject(
            new PlatformError(
              'agent.unreachable',
              { socket: this.socketPath, reason: err.code ?? err.message },
              { cause: err },
            ),
          );
        });
      });
      sock.on('close', () => {
        done(() => {
          reject(
            new PlatformError('agent.unreachable', {
              socket: this.socketPath,
              reason: 'connection closed before a response',
            }),
          );
        });
      });
      sock.write(frame);
    });
  }
}
