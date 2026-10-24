// SPDX-License-Identifier: AGPL-3.0-only
/** Assembles the Fastify app from its dependencies; main.ts supplies the real ones, tests supply fakes. */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { z } from 'zod';
import { PlatformError, isPlatformError, permissions } from '@opendc/shared';
import type { AgentClient } from '@opendc/shared/agent';
import type { PlatformDb } from '@opendc/shared/db';
import { empty } from '@opendc/shared/api';
import { AuditLog } from './audit.ts';
import type { AuthenticatedUser } from './directory.ts';
import { JobRunner } from './jobs.ts';
import { SESSION_COOKIE, SessionStore, type Session } from './sessions.ts';
import { RbacEngine, type Assignment, type Role } from './rbac/engine.ts';
import { BUILTIN_ROLES, builtinAssignments } from './rbac/builtin.ts';
import { RouteTable } from './http/route.ts';
import { StaticSite } from './http/static.ts';
import { coreRoutes } from './routes/core.ts';

export interface ApiDeps {
  db: PlatformDb;
  directory: { authenticate(username: string, password: string): Promise<AuthenticatedUser> };
  agent: Pick<AgentClient, 'call'> | null;
  /** Origin id for the audit hash chain (Phase 1: the node FQDN; the computer GUID from Phase 4). */
  nodeId: string;
  csrfKey: Buffer;
  idleMinutes: number;
  absoluteHours: number;
  webDir: string | null;
  validateResponses: boolean;
  logger?: FastifyServerOptions['logger'];
  https?: { key: Buffer | string; cert: Buffer | string } | null;
  trustProxy?: boolean;
  /** Directory-stored roles/assignments (Phase 2); merged with the built-ins. */
  roles?: Role[];
  assignments?: Assignment[];
}

export interface Api {
  app: FastifyInstance;
  routes: RouteTable;
  audit: AuditLog;
  sessions: SessionStore;
  jobs: JobRunner;
}

const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // Mantine sets style attributes and CSS variables at runtime; scripts stay strict.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

export async function buildApi(deps: ApiDeps): Promise<Api> {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
    ...(deps.https ? { https: { key: deps.https.key, cert: deps.https.cert, minVersion: 'TLSv1.2' as const } } : {}),
    ajv: undefined,
  } as FastifyServerOptions);

  // Zod is the only validator (ADR-0011): requests always, responses in dev/test.
  app.setValidatorCompiler(({ schema }) => (data: unknown) => {
    const r = (schema as z.ZodType).safeParse(data);
    if (r.success) return { value: r.data };
    return {
      error: new PlatformError('validation.invalid', {
        issues: r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
      }),
    };
  });
  app.setSerializerCompiler(
    ({ schema }) =>
      (data: unknown) =>
        JSON.stringify(deps.validateResponses ? (schema as z.ZodType).parse(data) : data),
  );

  const idleMs = deps.idleMinutes * 60_000;
  const absoluteMs = deps.absoluteHours * 3_600_000;
  const sessions = new SessionStore(deps.db, { idleMs, absoluteMs, csrfKey: deps.csrfKey });
  const audit = new AuditLog(deps.db, deps.nodeId);
  const jobs = new JobRunner(deps.db);
  const engines = new Map<string, RbacEngine>();
  const engineFor = (domainSid: string): RbacEngine => {
    let e = engines.get(domainSid);
    if (!e) {
      e = new RbacEngine(
        permissions,
        [...BUILTIN_ROLES, ...(deps.roles ?? [])],
        [...builtinAssignments(domainSid), ...(deps.assignments ?? [])],
      );
      engines.set(domainSid, e);
    }
    return e;
  };

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP },
    hsts: { maxAge: 31_536_000, includeSubDomains: false },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new PlatformError('auth.rate-limited', { retryAfterSec: Math.ceil(ctx.ttl / 1000) }),
  });

  app.setErrorHandler((err, request, reply) => {
    let e: PlatformError;
    if (isPlatformError(err)) e = err;
    else if ((err as { statusCode?: number }).statusCode === 429)
      e = new PlatformError('auth.rate-limited', { retryAfterSec: 60 });
    else if (
      (err as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      (err as { statusCode?: number }).statusCode === 415
    ) {
      e = new PlatformError('validation.invalid', { issues: 'content-type must be application/json' });
    } else if ((err as { statusCode?: number }).statusCode === 400)
      e = new PlatformError('validation.invalid', { issues: (err as Error).message });
    else {
      request.log.error({ err }, 'unhandled error');
      e = new PlatformError('internal', { requestId: request.id });
    }
    if (e.httpStatus >= 500) request.log.error({ code: e.code, err: e.cause ?? e }, e.message);
    void reply.code(e.httpStatus).type('application/json').send(JSON.stringify(e.toBody()));
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type('application/json')
      .send(JSON.stringify(new PlatformError('request.not-found', { what: request.url.split('?')[0] ?? '' }).toBody()));
  });

  const routes = new RouteTable();
  coreRoutes(routes, {
    sessions,
    audit,
    jobs,
    directory: deps.directory,
    agent: deps.agent,
    engineFor,
    idleMs,
    absoluteMs,
  });

  if (deps.webDir) {
    const site = new StaticSite(deps.webDir);
    const serve = async (rel: string, reply: import('fastify').FastifyReply): Promise<undefined> => {
      const f = await site.get(rel);
      if (!f) throw new PlatformError('request.not-found', { what: `/console/${rel}` });
      void reply.header('cache-control', f.cache).type(f.type).send(f.body);
      return undefined;
    };
    routes.add({
      method: 'GET',
      url: '/',
      operationId: 'root',
      summary: 'Redirect to the console',
      tags: ['web'],
      auth: 'public',
      response: empty,
      stream: true,
      handler: async (c) => {
        void c.reply.redirect('/console/');
        return Promise.resolve(undefined);
      },
    });
    routes.add({
      method: 'GET',
      url: '/console/*',
      operationId: 'console',
      summary: 'Console single-page app',
      tags: ['web'],
      auth: 'public',
      response: empty,
      stream: true,
      handler: async (c) => serve((c.params as { '*': string })['*'], c.reply),
    });
  }

  routes.mount(app, {
    session: (req) => sessions.get(req.cookies[SESSION_COOKIE]),
    checkOrigin: (req) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      let ok: boolean;
      try {
        ok = !!origin && !!host && new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) throw new PlatformError('auth.csrf');
    },
    checkCsrf: (req, _s: Session) => {
      const id = req.cookies[SESSION_COOKIE] ?? '';
      const token = req.headers['x-csrf-token'];
      if (!sessions.checkCsrf(id, typeof token === 'string' ? token : undefined)) throw new PlatformError('auth.csrf');
    },
    can: (s, permission, target) =>
      engineFor(s.domainSid).can({ sid: s.sid, groupSids: s.groupSids }, permission, target),
    denied: (req, s, permission, reason) => {
      audit.append({
        actor: s.username,
        actorSid: s.sid,
        sourceIp: req.ip,
        action: `access.${permission}`,
        result: 'denied',
        after: { reason, url: req.url },
        requestId: req.id,
      });
    },
  });

  // Housekeeping: drop expired sessions every 10 minutes.
  const purge = setInterval(() => sessions.purgeExpired(), 600_000);
  purge.unref();
  app.addHook('onClose', async () => {
    clearInterval(purge);
    return Promise.resolve();
  });

  return { app, routes, audit, sessions, jobs };
}
