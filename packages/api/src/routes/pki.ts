// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/pki (ADR-0007): the root and issuing CAs, pending issuer requests, issued certificates. Approving a DC's
 * issuing CA (on the DC that holds the root key) and revoking a certificate are tier-0 actions with a typed
 * confirmation. The root certificate and every issuer's CRL are public (/pki/root.pem, /pki/crl/<issuer>.crl).
 */
import { X509Certificate } from 'node:crypto';
import { PlatformError } from '@opendc/shared';
import { mintConfirmation, type AgentClient } from '@opendc/shared/agent';
import { REVOCATION_REASONS, pkiCert, pkiIssuer, pkiIssuerRequest, pkiRoot } from '@opendc/shared/pki';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import { PlatformObjects } from '../directory/platform-objects.ts';
import type { DirectoryService } from '../directory/service.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;

const certInfo = (pem: string) => {
  const x = new X509Certificate(pem);
  return {
    subject: x.subject.replace(/\n/g, ', '),
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    fingerprint: x.fingerprint256,
  };
};
const certView = z.object({
  subject: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprint: z.string(),
});
export const pkiOverview = z.object({
  root: certView.extend({ holder: z.string() }).nullable(),
  issuers: z.array(
    certView.extend({
      id: z.string(),
      host: z.string(),
      crlNumber: z.number(),
      crlNextUpdate: z.string().nullable(),
      revoked: z.number(),
    }),
  ),
  requests: z.array(z.object({ nodeGuid: z.string(), host: z.string(), requestedAt: z.string(), state: z.string() })),
  certificates: z.array(pkiCert),
});
const nodeParams = z.strictObject({ nodeGuid: z.uuid() });
const serialParams = z.strictObject({ serial: z.string().regex(/^[0-9A-Fa-f]{2,64}$/) });
const issuerParams = z.strictObject({ issuer: z.string().regex(/^issuer-[a-z0-9-]{1,63}\.crl$/) });

export function pkiRoutes(
  t: RouteTable,
  d: {
    directory: () => DirectoryService;
    agent: () => Pick<AgentClient, 'call'>;
    audit: AuditLog;
    confirmKey: Buffer;
  },
): void {
  const store = <S extends z.ZodType>(path: string[], kind: string, data: S) =>
    new PlatformObjects({ dir: d.directory, path, kind, schemaVersion: 1, data, name: () => kind });
  const roots = store(['PKI'], 'pki.root', pkiRoot);
  const issuers = store(['PKI', 'Issuers'], 'pki.issuer', pkiIssuer);
  const requests = store(['PKI', 'Requests'], 'pki.issuerRequest', pkiIssuerRequest);
  const certs = store(['PKI', 'Certificates'], 'pki.cert', pkiCert);
  const list = async <T>(s: { list(): Promise<{ data: T }[]> }): Promise<T[]> =>
    (await s.list().catch(() => [])).map((x) => x.data);
  const actor = (c: Ctx) => ({ name: c.user.username, sid: c.user.sid, via: 'api' as const });

  t.add({
    method: 'GET',
    url: '/api/v1/pki',
    operationId: 'getPki',
    summary: 'Root and issuing CAs, pending issuer requests, issued certificates',
    tags: ['pki'],
    auth: { permission: 'pki.read' },
    response: pkiOverview,
    handler: async () => {
      const [root] = await list(roots);
      const all = await list(certs);
      return {
        root: root ? { ...certInfo(root.certPem), holder: root.holder } : null,
        issuers: (await list(issuers)).map((i) => ({
          ...certInfo(i.certPem),
          id: i.id,
          host: i.host,
          crlNumber: i.crlNumber,
          crlNextUpdate: i.crlNextUpdate,
          revoked: i.crlSerials.length,
        })),
        requests: (await list(requests)).map(({ csrPem: _c, ...r }) => r),
        certificates: all.sort((a, b) => b.notBefore.localeCompare(a.notBefore)).slice(0, 500),
      };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/pki/requests/:nodeGuid/approve',
    operationId: 'approveIssuer',
    summary: "Sign a DC's issuing CA with the root key (on the DC that holds it; type the DC's host name)",
    tags: ['pki'],
    auth: 'session',
    params: nodeParams,
    body: z.strictObject({ confirm: z.string().max(64) }),
    response: z.object({ issuer: z.string(), host: z.string() }),
    handler: async (c) => {
      c.require('pki.manage', { protected: true, label: 'PKI' });
      const req = (await list(requests)).find((r) => r.nodeGuid.toLowerCase() === c.params.nodeGuid.toLowerCase());
      if (!req) throw new PlatformError('request.not-found', { what: `Issuer request ${c.params.nodeGuid}` });
      if (c.body.confirm.trim().toLowerCase() !== req.host.toLowerCase())
        throw new PlatformError('agent.confirmation-required', { op: 'ca.issuer.create' });
      const args = { nodeGuid: c.params.nodeGuid };
      const confirmation = mintConfirmation(d.confirmKey, { op: 'ca.issuer.create', args, actor: c.user.sid });
      const r = await d.agent().call('ca.issuer.create', args, { actor: actor(c), confirmation });
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'pki.issuer.approve',
        result: 'success',
        targetGuid: c.params.nodeGuid,
        after: r,
        requestId: c.requestId,
      });
      return r;
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/pki/certificates/:serial/revoke',
    operationId: 'revokeCertificate',
    summary: 'Revoke a certificate (type its serial to confirm); the issuing DC publishes a new CRL',
    tags: ['pki'],
    auth: 'session',
    params: serialParams,
    body: z.strictObject({ reason: z.enum(REVOCATION_REASONS).default('unspecified'), confirm: z.string().max(64) }),
    response: z.object({ serial: z.string(), issuerId: z.string(), crlUpdated: z.boolean() }),
    handler: async (c) => {
      c.require('pki.manage', { protected: true, label: 'PKI' });
      if (c.body.confirm.trim().toUpperCase() !== c.params.serial.toUpperCase())
        throw new PlatformError('agent.confirmation-required', { op: 'cert.revoke' });
      const args = { serial: c.params.serial.toUpperCase(), reason: c.body.reason };
      const confirmation = mintConfirmation(d.confirmKey, { op: 'cert.revoke', args, actor: c.user.sid });
      const r = await d.agent().call('cert.revoke', args, { actor: actor(c), confirmation });
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'pki.cert.revoke',
        result: 'success',
        after: { ...r, reason: c.body.reason },
        requestId: c.requestId,
      });
      return r;
    },
  });

  // ---- public: the root certificate and CRLs (CRL distribution points in every certificate) ----
  const raw = (c: Ctx, type: string, body: string | null): Record<string, never> => {
    if (body === null) throw new PlatformError('request.not-found', { what: 'PKI object' });
    const r = c.reply.raw;
    c.reply.hijack();
    r.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
    r.end(body);
    return {};
  };

  t.add({
    method: 'GET',
    url: '/pki/root.pem',
    operationId: 'getRootCertificate',
    summary: 'The root CA certificate (PEM)',
    tags: ['pki'],
    auth: 'public',
    response: z.object({}),
    stream: true,
    handler: async (c) => raw(c, 'application/x-pem-file', (await list(roots))[0]?.certPem ?? null),
  });

  t.add({
    method: 'GET',
    url: '/pki/crl/:issuer',
    operationId: 'getCrl',
    summary: "An issuing CA's certificate revocation list (PEM)",
    tags: ['pki'],
    auth: 'public',
    params: issuerParams,
    response: z.object({}),
    stream: true,
    handler: async (c) => {
      const id = c.params.issuer.replace(/\.crl$/, '');
      const issuer = (await list(issuers)).find((i) => i.id === id);
      return raw(c, 'application/pkix-crl', issuer?.crlPem ?? null);
    },
  });
}
