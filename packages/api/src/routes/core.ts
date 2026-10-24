// SPDX-License-Identifier: AGPL-3.0-only
/** Phase 1 core routes: health, session (login/logout), permissions, node info, audit, jobs. */
import { PlatformError, isPlatformError, platformVersion } from '@opendc/shared';
import {
  auditList,
  auditQuery,
  empty,
  health,
  job,
  jobParams,
  loginRequest,
  nodeInfo,
  permissionsResponse,
  sessionInfo,
} from '@opendc/shared/api';
import type { AgentClient } from '@opendc/shared/agent';
import type { AuditLog } from '../audit.ts';
import type { AuthenticatedUser } from '../directory.ts';
import type { JobRunner } from '../jobs.ts';
import { SESSION_COOKIE, type Session, type SessionStore } from '../sessions.ts';
import type { RbacEngine } from '../rbac/engine.ts';
import type { RouteTable } from '../http/route.ts';

export interface CoreDeps {
  sessions: SessionStore;
  audit: AuditLog;
  jobs: JobRunner;
  directory: { authenticate(username: string, password: string): Promise<AuthenticatedUser> };
  agent: Pick<AgentClient, 'call'> | null;
  engineFor(domainSid: string): RbacEngine;
  idleMs: number;
  absoluteMs: number;
}

const subject = (s: Session): { sid: string; groupSids: string[] } => ({ sid: s.sid, groupSids: s.groupSids });

function info(s: Session, csrfToken: string, d: CoreDeps): ReturnType<typeof sessionInfo.parse> {
  return {
    user: { sid: s.sid, guid: s.guid, username: s.username, displayName: s.displayName, dn: s.dn },
    csrfToken,
    expiresAt: new Date(s.createdAt + d.absoluteMs).toISOString(),
    idleTimeoutSec: Math.round(d.idleMs / 1000),
  };
}

export function coreRoutes(t: RouteTable, d: CoreDeps): void {
  t.add({
    method: 'GET',
    url: '/api/v1/health',
    operationId: 'health',
    summary: 'Liveness check',
    tags: ['core'],
    auth: 'public',
    response: health,
    handler: async () => Promise.resolve({ status: 'ok' as const, version: platformVersion }),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/session',
    operationId: 'login',
    summary: 'Log in with domain credentials (LDAPS bind against a verified DC)',
    tags: ['session'],
    auth: 'public',
    body: loginRequest,
    response: sessionInfo,
    rateLimit: { max: 10, windowSec: 60 },
    handler: async (c) => {
      const attempted = c.body.username.normalize('NFC').trim().slice(0, 128);
      let user: AuthenticatedUser;
      try {
        user = await d.directory.authenticate(c.body.username, c.body.password);
      } catch (e) {
        if (isPlatformError(e) && e.code.startsWith('auth.')) {
          d.audit.append({
            actor: attempted,
            sourceIp: c.ip,
            action: 'session.login',
            result: 'failure',
            after: { reason: e.code },
            requestId: c.requestId,
          });
        }
        throw e;
      }
      const engine = d.engineFor(user.domainSid);
      if (!engine.can({ sid: user.sid, groupSids: user.groupSids }, 'core.console.access').allow) {
        d.audit.append({
          actor: user.username,
          actorSid: user.sid,
          sourceIp: c.ip,
          action: 'session.login',
          result: 'denied',
          targetGuid: user.guid,
          requestId: c.requestId,
        });
        throw new PlatformError('auth.forbidden', { permission: 'core.console.access' });
      }
      const { id, session } = d.sessions.create(
        {
          sid: user.sid,
          guid: user.guid,
          username: user.username,
          displayName: user.displayName,
          dn: user.dn,
          domainSid: user.domainSid,
          groupSids: user.groupSids,
        },
        c.ip,
      );
      d.audit.append({
        actor: user.username,
        actorSid: user.sid,
        sourceIp: c.ip,
        action: 'session.login',
        result: 'success',
        targetGuid: user.guid,
        targetDn: user.dn,
        after: { dc: user.dc },
        requestId: c.requestId,
      });
      void c.reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
      return info(session, d.sessions.csrfToken(id), d);
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/session',
    operationId: 'getSession',
    summary: 'The current session and its CSRF token',
    tags: ['session'],
    auth: 'session',
    response: sessionInfo,
    handler: async (c) =>
      Promise.resolve(info(c.user, d.sessions.csrfToken(c.request.cookies[SESSION_COOKIE] ?? ''), d)),
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/session',
    operationId: 'logout',
    summary: 'Log out',
    tags: ['session'],
    auth: 'session',
    response: empty,
    handler: async (c) => {
      d.sessions.destroy(c.request.cookies[SESSION_COOKIE]);
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'session.logout',
        result: 'success',
        requestId: c.requestId,
      });
      void c.reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
      return Promise.resolve({});
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/session/permissions',
    operationId: 'getPermissions',
    summary: 'Effective permissions of the current user (for display; the server enforces regardless)',
    tags: ['session'],
    auth: 'session',
    response: permissionsResponse,
    handler: async (c) => Promise.resolve({ permissions: d.engineFor(c.user.domainSid).effective(subject(c.user)) }),
  });

  t.add({
    method: 'GET',
    url: '/api/v1/node',
    operationId: 'getNode',
    summary: 'This node: OS, role, versions (through the agent)',
    tags: ['node'],
    auth: { permission: 'core.node.info' },
    response: nodeInfo,
    handler: async (c) => {
      if (!d.agent)
        throw new PlatformError('agent.unreachable', { socket: '(not configured)', reason: 'no agent socket' });
      const actor = { name: c.user.username, sid: c.user.sid, via: 'api' as const };
      const [i, samba] = await Promise.all([
        d.agent.call('system.info', {}, { actor }),
        d.agent.call('samba.version', {}, { actor }),
      ]);
      return {
        hostname: i.hostname,
        fqdn: i.fqdn,
        role: i.role,
        os: i.os,
        kernel: i.kernel,
        uptimeSec: i.uptimeSec,
        cpus: i.cpus,
        memTotal: i.memTotal,
        samba: samba ? `${String(samba.major)}.${String(samba.minor)}.${String(samba.patch)}` : null,
        platformVersion,
      };
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/audit',
    operationId: 'listAudit',
    summary: 'Audit log, newest first',
    tags: ['audit'],
    auth: { permission: 'core.audit.read' },
    query: auditQuery,
    response: auditList,
    handler: async (c) =>
      Promise.resolve({
        entries: d.audit
          .list({
            ...(c.query.limit ? { limit: c.query.limit } : {}),
            ...(c.query.before ? { beforeTs: c.query.before } : {}),
          })
          .map(({ before: _b, after: _a, prevHash: _p, hash: _h, ...e }) => e),
      }),
  });

  const visible = (c: { user: Session; require: (p: string) => void }, j: { actorSid: string | null }): void => {
    if (j.actorSid !== c.user.sid) c.require('core.audit.read');
  };

  t.add({
    method: 'POST',
    url: '/api/v1/jobs/node-info',
    operationId: 'startNodeInfoJob',
    summary: 'Start a job that collects node information through the agent (exercises jobs and SSE)',
    tags: ['jobs'],
    auth: { permission: 'core.node.info' },
    response: job,
    status: 202,
    handler: async (c) => {
      const agent = d.agent;
      const actor = { name: c.user.username, sid: c.user.sid, via: 'api' as const };
      const j = d.jobs.start('core.node-info', { name: c.user.username, sid: c.user.sid }, async (progress) => {
        if (!agent)
          throw new PlatformError('agent.unreachable', { socket: '(not configured)', reason: 'no agent socket' });
        progress({ step: 'system.info', percent: 10 });
        const i = await agent.call('system.info', {}, { actor });
        progress({ step: 'samba.version', percent: 60 });
        const s = await agent.call('samba.version', {}, { actor });
        progress({ step: 'done', percent: 100 });
        return { fqdn: i.fqdn, role: i.role, os: i.os.prettyName, samba: s?.raw ?? null };
      });
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'job.start',
        result: 'success',
        after: { type: j.type, id: j.id },
        requestId: c.requestId,
      });
      return Promise.resolve(j);
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/jobs/:id',
    operationId: 'getJob',
    summary: 'Job state',
    tags: ['jobs'],
    auth: { permission: 'core.jobs.read' },
    params: jobParams,
    response: job,
    handler: async (c) => {
      const j = d.jobs.get(c.params.id);
      if (!j) throw new PlatformError('request.not-found', { what: `Job ${c.params.id}` });
      visible(c, j);
      return Promise.resolve(j);
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/jobs/:id/events',
    operationId: 'streamJobEvents',
    summary: 'Job progress as server-sent events (supports Last-Event-ID)',
    tags: ['jobs'],
    auth: { permission: 'core.jobs.read' },
    params: jobParams,
    response: empty,
    stream: true,
    handler: async (c) => {
      const j = d.jobs.get(c.params.id);
      if (!j) throw new PlatformError('request.not-found', { what: `Job ${c.params.id}` });
      visible(c, j);
      const after = Number(c.request.headers['last-event-id'] ?? 0) || 0;
      const raw = c.reply.raw;
      c.reply.hijack();
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (ev: { n: number; kind: string; data: unknown }): void => {
        raw.write(`id: ${String(ev.n)}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        if (ev.kind !== 'progress') raw.end();
      };
      let last = after;
      const unsubscribe = d.jobs.subscribe(j.id, (ev) => {
        if (ev.n > last) {
          last = ev.n;
          send(ev);
        }
      });
      for (const ev of d.jobs.events(j.id, after)) {
        last = ev.n;
        send(ev);
      }
      const keepalive = setInterval(() => raw.write(': keepalive\n\n'), 15_000);
      raw.on('close', () => {
        clearInterval(keepalive);
        unsubscribe();
      });
      return Promise.resolve(undefined);
    },
  });
}
