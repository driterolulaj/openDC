// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Route definitions (ADR-0011): every route declares its Zod schemas and its authorization (a permission,
 * "session" or "public"). The same table drives validation, the auth preHandler and the OpenAPI document,
 * and the server refuses to start if a route was registered any other way (SECURITY.md §5).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { PlatformError } from '@opendc/shared';
import type { Session } from '../sessions.ts';
import type { Target } from '../rbac/engine.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Auth = { permission: string } | 'session' | 'public';

type Infer<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteContext<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  session: Session | null;
  /** The session, for routes whose auth guarantees one. */
  user: Session;
  ip: string;
  requestId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Object-level permission check; throws auth.forbidden / auth.tier0-required. */
  require(permission: string, target?: Target & { label?: string }): void;
}

export interface RouteSpec<B extends z.ZodType | undefined, Q extends z.ZodType | undefined, P extends z.ZodType | undefined, R extends z.ZodType> {
  method: Method;
  url: string;
  operationId: string;
  summary: string;
  tags: string[];
  auth: Auth;
  body?: B;
  query?: Q;
  params?: P;
  response: R;
  status?: number;
  /** Server-sent events: the handler writes the stream itself and returns nothing. */
  stream?: boolean;
  rateLimit?: { max: number; windowSec: number };
  handler(ctx: RouteContext<Infer<B>, Infer<Q>, Infer<P>>): Promise<z.output<R> | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteSpec<any, any, any, z.ZodType>;

export interface AuthHooks {
  /** Resolves the session (or null) and enforces CSRF/Origin for state-changing requests. */
  session(request: FastifyRequest): Session | null;
  checkOrigin(request: FastifyRequest): void;
  checkCsrf(request: FastifyRequest, session: Session): void;
  can(session: Session, permission: string, target?: Target): { allow: true } | { allow: false; reason: string };
  denied(request: FastifyRequest, session: Session, permission: string, reason: string): void;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export class RouteTable {
  readonly routes: AnyRoute[] = [];
  readonly #registered = new Set<string>();

  add<B extends z.ZodType | undefined, Q extends z.ZodType | undefined, P extends z.ZodType | undefined, R extends z.ZodType>(spec: RouteSpec<B, Q, P, R>): void {
    if (this.routes.some((r) => r.operationId === spec.operationId)) throw new TypeError(`Duplicate operationId ${spec.operationId}`);
    this.routes.push(spec as AnyRoute);
  }

  /** Registers every route on the app; call before app.ready(). */
  mount(app: FastifyInstance, hooks: AuthHooks): void {
    // Every route must come from this table (plus the automatic HEAD twins of GET routes).
    app.addHook('onRoute', (opts) => {
      const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
      for (const m of methods) {
        const key = `${m} ${opts.url}`;
        if (m === 'HEAD' && this.#registered.has(`GET ${opts.url}`)) continue;
        if (!this.#registered.has(key)) throw new Error(`Route ${key} was registered without an authorization declaration`);
      }
    });
    for (const r of this.routes) {
      this.#registered.add(`${r.method} ${r.url}`);
      app.route({
        method: r.method,
        url: r.url,
        schema: {
          ...(r.body ? { body: r.body } : {}),
          ...(r.query ? { querystring: r.query } : {}),
          ...(r.params ? { params: r.params } : {}),
          ...(r.stream ? {} : { response: { [r.status ?? 200]: r.response } }),
        },
        ...(r.rateLimit ? { config: { rateLimit: { max: r.rateLimit.max, timeWindow: r.rateLimit.windowSec * 1000 } } } : {}),
        handler: async (request, reply) => {
          if (!SAFE.has(request.method)) hooks.checkOrigin(request);
          let session: Session | null = null;
          if (r.auth !== 'public') {
            session = hooks.session(request);
            if (!session) throw new PlatformError('auth.session-required');
            if (!SAFE.has(request.method)) hooks.checkCsrf(request, session);
            if (typeof r.auth === 'object') {
              const d = hooks.can(session, r.auth.permission);
              if (!d.allow) {
                hooks.denied(request, session, r.auth.permission, d.reason);
                throw new PlatformError('auth.forbidden', { permission: r.auth.permission });
              }
            }
          }
          const s = session;
          const ctx: RouteContext<unknown, unknown, unknown> = {
            body: request.body,
            query: request.query,
            params: request.params,
            session: s,
            get user(): Session {
              if (!s) throw new PlatformError('auth.session-required');
              return s;
            },
            ip: request.ip,
            requestId: request.id,
            request,
            reply,
            require(permission, target) {
              if (!s) throw new PlatformError('auth.session-required');
              const d = hooks.can(s, permission, target);
              if (d.allow) return;
              hooks.denied(request, s, permission, d.reason);
              if (d.reason === 'tier0') throw new PlatformError('auth.tier0-required', { target: target?.label ?? target?.dn ?? '?' });
              throw new PlatformError('auth.forbidden', { permission });
            },
          };
          const out = await r.handler(ctx as never);
          if (r.stream) return reply;
          reply.code(r.status ?? 200);
          return out;
        },
      });
    }
  }
}
