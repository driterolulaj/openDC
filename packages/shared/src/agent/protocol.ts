// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agent wire protocol (ADR-0006, agent-operations.md §1): newline-delimited JSON-RPC 2.0 over a Unix stream
 * socket, at most 4 MiB per frame.
 */
import { z } from 'zod';
import { errorCodes, type ErrorBody } from '../errors.ts';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const actorSchema = z.strictObject({
  sid: z.string().max(200).optional(),
  name: z.string().min(1).max(256),
  via: z.enum(['api', 'node-rpc', 'watcher', 'cli']),
});
export type Actor = z.infer<typeof actorSchema>;

export const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.string().min(1).max(64),
  method: z.string().min(1).max(128),
  params: z.strictObject({
    v: z.number().int().positive(),
    args: z.unknown(),
    actor: actorSchema,
    idempotencyKey: z.string().max(128).optional(),
    /** Typed-confirmation token minted by the API (confirm.ts). */
    confirmation: z.string().max(4096).optional(),
  }),
});
export type AgentRequest = z.infer<typeof requestSchema>;

const errorBodySchema = z.strictObject({
  code: z.enum(errorCodes as [string, ...string[]]),
  message: z.string(),
  fix: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: z.string().nullable(),
    error: z.strictObject({ code: z.number().int(), message: z.string(), data: errorBodySchema }),
  }),
]);

export const progressSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal('progress'),
  params: z.strictObject({
    id: z.string(),
    step: z.string(),
    percent: z.number().min(0).max(100).optional(),
    line: z.string().optional(),
  }),
});
export type Progress = z.infer<typeof progressSchema>['params'];

/** JSON-RPC error codes: our errors use the server-error range. */
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_SERVER_ERROR = -32000;

export function errorResponse(id: string | null, rpcCode: number, body: ErrorBody): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code: rpcCode, message: body.message, data: body } }) + '\n';
}

export function resultResponse(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

export function progressFrame(p: Progress): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: p }) + '\n';
}

/**
 * Splits a byte stream into newline-delimited frames. Rejects (and stops) on a frame above `max` bytes,
 * so a peer can't make the reader buffer unbounded data.
 */
export class FrameReader {
  #buf: Buffer[] = [];
  #len = 0;
  #failed = false;
  private readonly onFrame: (line: string) => void;
  private readonly onTooLarge: () => void;
  private readonly max: number;

  constructor(onFrame: (line: string) => void, onTooLarge: () => void, max = MAX_FRAME_BYTES) {
    this.onFrame = onFrame;
    this.onTooLarge = onTooLarge;
    this.max = max;
  }

  push(chunk: Buffer): void {
    if (this.#failed) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      this.#len += piece.length;
      if (this.#len > this.max) {
        this.#failed = true;
        this.#buf = [];
        this.onTooLarge();
        return;
      }
      this.#buf.push(piece);
      if (nl === -1) return;
      const line = Buffer.concat(this.#buf).toString('utf8');
      this.#buf = [];
      this.#len = 0;
      if (line.trim() !== '') this.onFrame(line);
      start = nl + 1;
      if (start >= chunk.length) return;
    }
  }
}
