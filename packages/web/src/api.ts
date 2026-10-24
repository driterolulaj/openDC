// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hand-written API client (ADR-0014 §6). Same-origin only; keeps the CSRF token from GET /session and sends
 * it on every state-changing request. Responses are parsed with the shared Zod contract.
 */
import type { z } from 'zod';
import { errorBody, type ApiError } from '@opendc/shared/api';

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface RequestOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema: S;
  signal?: AbortSignal;
}

export async function api<S extends z.ZodType>(path: string, opts: RequestOptions<S>): Promise<z.output<S>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const data: unknown = res.status === 204 ? {} : await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorBody.safeParse(data);
    throw new ApiFailure(
      res.status,
      parsed.success ? parsed.data : { code: 'internal', message: res.statusText, fix: '', params: { requestId: '-' } },
    );
  }
  return opts.schema.parse(data);
}
