// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node RPC (ADR-0007 §4): mutual TLS between OpenDC nodes. TLS 1.3 only; the peer must present a node certificate
 * that chains to the OpenDC CAs and isn't on an issuer's CRL; its `urn:opendc:node:<guid>` must name an enabled
 * computer account. Phase 3 serves only GET /node/v1/ping (the remote actions arrive in Phase 4). The CA bundle and
 * the CRLs are refreshed every minute without a restart.
 */
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

export interface NodeRpcOptions {
  key: Buffer;
  cert: Buffer;
  /** the OpenDC root and issuing CAs (PEM) */
  ca: () => Promise<string>;
  /** every issuer's current CRL (PEM) */
  crls: () => Promise<string[]>;
  /** is this computer account an enabled node? its name otherwise null */
  node: (guid: string) => Promise<{ name: string; enabled: boolean } | null>;
  self: string;
  log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
  refreshMs?: number;
}

/** The node GUID in a peer certificate's subjectAltName (URI:urn:opendc:node:<guid>). */
export function peerNodeGuid(subjectAltName: string | undefined): string | null {
  const m = /URI:urn:opendc:node:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    subjectAltName ?? '',
  );
  return m?.[1]?.toLowerCase() ?? null;
}

export async function startNodeRpc(
  o: NodeRpcOptions,
  listen: { host: string; port: number },
): Promise<{ server: Server; refresh: () => Promise<void>; close: () => Promise<void> }> {
  const context = async () => ({ key: o.key, cert: o.cert, ca: await o.ca(), crl: await o.crls() });
  const server = createServer(
    { ...(await context()), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    (req: IncomingMessage, res: ServerResponse) => {
      void handle(req, res);
    },
  );
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    const guid = peerNodeGuid(peer.subjectaltname);
    const node = guid ? await o.node(guid).catch(() => null) : null;
    if (!guid || !node?.enabled) {
      o.log('warn', 'node RPC refused', {
        guid,
        reason: !guid ? 'no node identity' : node ? 'disabled' : 'unknown node',
      });
      send(res, 403, { code: 'auth.forbidden', message: 'not an enabled OpenDC node' });
      return;
    }
    if (req.method === 'GET' && req.url === '/node/v1/ping') {
      send(res, 200, { node: o.self, peer: { guid, name: node.name } });
      return;
    }
    send(res, 404, { code: 'request.not-found' });
  }
  // a peer refused during the handshake (unknown CA, revoked, expired) leaves a trace
  server.on('tlsClientError', (err, socket) => {
    o.log('warn', 'node RPC handshake refused', {
      peer: socket.remoteAddress ?? '?',
      error: err.message.slice(0, 200),
    });
  });
  const refresh = async (): Promise<void> => {
    server.setSecureContext(await context());
  };
  const timer = setInterval(() => {
    refresh().catch((e: unknown) => {
      o.log('warn', 'node RPC trust refresh failed', { error: e instanceof Error ? e.message : String(e) });
    });
  }, o.refreshMs ?? 60_000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    refresh,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        server.close(() => {
          resolve();
        });
      }),
  };
}
