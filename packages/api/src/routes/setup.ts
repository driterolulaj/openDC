// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Setup wizard API (ROADMAP Phase 2; agent-operations.md §5). Before the domain exists there are no users and
 * no RBAC, so these routes are public and authorised by the one-time setup token in the X-Setup-Token header.
 * The API never stores or checks the token itself: every call passes it to the agent, which verifies it
 * against the root-only token file. After provisioning or join the agent destroys the token, which closes
 * these routes, and the API restarts itself to pick up its new directory configuration.
 */
import { PlatformError } from '@opendc/shared';
import {
  SETUP_TOKEN_HEADER,
  setupJobParams,
  setupJobResponse,
  setupJoinRequest,
  setupPreflightRequest,
  setupPreflightResponse,
  setupProvisionRequest,
  setupStatusResponse,
  job as jobSchema,
} from '@opendc/shared/api';
import { mintConfirmation, type AgentClient } from '@opendc/shared/agent';
import { confirmationPhrase } from '@opendc/shared/domain';
import type { FastifyRequest } from 'fastify';
import type { AuditLog } from '../audit.ts';
import type { JobRunner } from '../jobs.ts';
import type { RouteTable } from '../http/route.ts';

export interface SetupDeps {
  agent: Pick<AgentClient, 'call'> | null;
  jobs: JobRunner;
  audit: AuditLog;
  /** HMAC key shared with the agent for typed confirmations (api-hmac). */
  confirmKey: Buffer;
  /** Restarts this API after setup (through the agent); tests replace it. */
  restartSelf: () => void;
}

const ACTOR = { name: 'setup', via: 'api' as const };
const LIMIT = { max: 30, windowSec: 60 };

function tokenOf(req: FastifyRequest): string | undefined {
  const v = req.headers[SETUP_TOKEN_HEADER];
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
}

export function setupRoutes(t: RouteTable, d: SetupDeps): void {
  const agent = (): Pick<AgentClient, 'call'> => {
    if (!d.agent)
      throw new PlatformError('agent.unreachable', { socket: '(not configured)', reason: 'no agent socket' });
    return d.agent;
  };
  const requireToken = async (req: FastifyRequest): Promise<string> => {
    const token = tokenOf(req);
    if (!token) throw new PlatformError('setup.token-invalid');
    const s = await agent().call('setup.status', {}, { actor: ACTOR, setupToken: token });
    if (s.provisioned) throw new PlatformError('setup.already-provisioned', { domain: s.domain ?? '?' });
    if (s.tokenValid !== true) throw new PlatformError('setup.token-invalid');
    return token;
  };

  t.add({
    method: 'GET',
    url: '/api/v1/setup/status',
    operationId: 'getSetupStatus',
    summary: 'Whether this node is set up; host details only with a valid setup token',
    tags: ['setup'],
    auth: 'public',
    response: setupStatusResponse,
    rateLimit: LIMIT,
    handler: async (c) => {
      const token = tokenOf(c.request);
      const s = await agent().call('setup.status', {}, { actor: ACTOR, ...(token ? { setupToken: token } : {}) });
      if (s.tokenValid === true && !s.provisioned) return s;
      // without the token: nothing about the host beyond what its certificate already shows
      return { ...s, tokenValid: token ? false : null, addresses: [], nameservers: [], os: '' };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/setup/preflight',
    operationId: 'runSetupPreflight',
    summary: 'Pre-flight checks for provisioning or joining (setup token)',
    tags: ['setup'],
    auth: 'public',
    body: setupPreflightRequest,
    response: setupPreflightResponse,
    rateLimit: LIMIT,
    handler: async (c) => {
      const token = await requireToken(c.request);
      return agent().call('setup.preflight', c.body, { actor: ACTOR, setupToken: token, timeoutMs: 180_000 });
    },
  });

  const start = (
    kind: 'provision' | 'join',
    token: string,
    body: { confirm: string; domain: string },
    args: Record<string, unknown>,
    ip: string,
    requestId: string,
  ): ReturnType<JobRunner['start']> => {
    if (body.confirm.trim().toLowerCase() !== confirmationPhrase(body)) {
      throw new PlatformError('agent.confirmation-required', { op: `samba.${kind}` });
    }
    const op = kind === 'provision' ? 'samba.provision' : 'samba.join';
    const confirmation = mintConfirmation(d.confirmKey, { op, args, actor: ACTOR.name });
    const a = agent();
    const job = d.jobs.start(`setup.${kind}`, { name: ACTOR.name, sid: null }, async (progress) => {
      const call = {
        actor: ACTOR,
        setupToken: token,
        confirmation,
        timeoutMs: 3_600_000,
        onProgress: (p: { step: string; percent?: number | undefined }) => {
          progress({ step: p.step, ...(p.percent === undefined ? {} : { percent: p.percent }) });
        },
      };
      const result =
        kind === 'provision'
          ? await a.call('samba.provision', args as never, call)
          : await a.call('samba.join', args as never, call);
      d.audit.append({
        actor: ACTOR.name,
        sourceIp: ip,
        action: `setup.${kind}`,
        result: 'success',
        after: { domain: result.domain, dc: result.dcFqdn, serviceAccounts: result.serviceAccounts.map((s) => s.name) },
        requestId,
      });
      // pick up the new directory configuration and credentials
      d.restartSelf();
      return result;
    });
    d.audit.append({
      actor: ACTOR.name,
      sourceIp: ip,
      action: `setup.${kind}.start`,
      result: 'success',
      after: { domain: body.domain, job: job.id },
      requestId,
    });
    return job;
  };

  t.add({
    method: 'POST',
    url: '/api/v1/setup/provision',
    operationId: 'startSetupProvision',
    summary: 'Provision a new domain with this host as its first DC (setup token, typed confirmation)',
    tags: ['setup'],
    auth: 'public',
    body: setupProvisionRequest,
    response: jobSchema,
    status: 202,
    rateLimit: { max: 5, windowSec: 60 },
    handler: async (c) => {
      const token = await requireToken(c.request);
      const { confirm: _c, ...args } = c.body;
      return start('provision', token, c.body, args, c.ip, c.requestId);
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/setup/join',
    operationId: 'startSetupJoin',
    summary: 'Join this host to an existing domain as an additional DC (setup token, typed confirmation)',
    tags: ['setup'],
    auth: 'public',
    body: setupJoinRequest,
    response: jobSchema,
    status: 202,
    rateLimit: { max: 5, windowSec: 60 },
    handler: async (c) => {
      const token = await requireToken(c.request);
      const { confirm: _c, ...args } = c.body;
      return start('join', token, c.body, args, c.ip, c.requestId);
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/setup/jobs/:id',
    operationId: 'getSetupJob',
    summary: 'State and progress of a setup job (setup token while it runs)',
    tags: ['setup'],
    auth: 'public',
    params: setupJobParams,
    response: setupJobResponse,
    rateLimit: { max: 120, windowSec: 60 },
    handler: async (c) => {
      const j = d.jobs.get(c.params.id);
      if (!j?.type.startsWith('setup.')) throw new PlatformError('request.not-found', { what: `Job ${c.params.id}` });
      // once setup finished the token is gone; the outcome (no secrets) stays readable for the wizard
      if (j.status === 'running') await requireToken(c.request);
      return {
        job: j,
        events: d.jobs.events(j.id).map((e) => ({ n: e.n, kind: e.kind, data: e.data })),
      };
    },
  });
}
