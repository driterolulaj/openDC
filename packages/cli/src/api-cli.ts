// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `opendc api`: the whole REST API from the command line, generated from the route table
 * (src/generated/operations.ts, written by `npm run openapi`), so it always covers every operation.
 *
 *   opendc api list [<filter>]
 *   opendc api <operation> [<path params>...] [--<query param> <value>]... [--data <json> | --data-file <file>|-]
 *
 * Operations accept their operationId or its kebab-case form (list-directory-objects). Connection:
 * --url / OPENDC_URL (default https://localhost:8443), an API token via --token / OPENDC_TOKEN (create one in
 * the console under Account), and the server's CA or self-signed certificate via --ca / OPENDC_CA.
 */
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { PlatformError } from '@opendc/shared';
import { operations, type Operation } from './generated/operations.ts';

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export type Transport = (o: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  ca: string | null;
}) => Promise<HttpResponse>;

export const httpsTransport: Transport = (o) =>
  new Promise((resolve, reject) => {
    const req = request(
      o.url,
      { method: o.method, headers: o.headers, ...(o.ca ? { ca: o.ca } : {}), minVersion: 'TLSv1.2', timeout: 300_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (o.body !== null) req.write(o.body);
    req.end();
  });

export interface ApiCliDeps {
  transport: Transport;
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export const kebab = (id: string): string => id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export function findOperation(name: string): Operation | undefined {
  const n = name.toLowerCase();
  return operations.find((o) => o.operationId.toLowerCase() === n || kebab(o.operationId) === n);
}

class Usage extends Error {}

export async function apiCommand(argv: string[], d: ApiCliDeps): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'list' || name === 'help') {
    const filter = (rest[0] ?? '').toLowerCase();
    const rows = operations.filter(
      (o) =>
        !filter || kebab(o.operationId).includes(filter) || o.path.toLowerCase().includes(filter) || o.tag === filter,
    );
    const width = Math.max(...rows.map((o) => kebab(o.operationId).length));
    for (const o of rows) {
      const args = o.pathParams.map((p) => `<${p}>`).join(' ');
      d.out(
        `${kebab(o.operationId).padEnd(width)}  ${o.method.padEnd(6)} ${o.path}${args ? `  ${args}` : ''}\n${' '.repeat(width + 2)}${o.summary}`,
      );
    }
    return name ? 0 : 2;
  }
  const op = findOperation(name);
  if (!op) {
    d.err(`Unknown API operation "${name}". List them with: opendc api list`);
    return 2;
  }

  // positional path params, --flags for query params and connection options
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith('--')) flags.set(a.slice(2), 'true');
        else {
          flags.set(a.slice(2), v);
          i++;
        }
      }
    } else positional.push(a);
  }
  try {
    if (positional.length !== op.pathParams.length)
      throw new Usage(
        `${kebab(op.operationId)} takes ${String(op.pathParams.length)} argument(s): ${op.pathParams.map((p) => `<${p}>`).join(' ') || 'none'}`,
      );
    let path: string = op.path;
    op.pathParams.forEach((p, i) => {
      path = path.replace(`:${p}`, encodeURIComponent(positional[i] ?? ''));
    });
    const query = new URLSearchParams();
    for (const q of op.queryParams as readonly string[]) {
      const v = flags.get(q);
      if (v !== undefined) query.set(q, v);
    }
    const known = new Set<string>([
      ...(op.queryParams as readonly string[]),
      'data',
      'data-file',
      'url',
      'token',
      'ca',
      'json',
    ]);
    const unknown = [...flags.keys()].filter((k) => !known.has(k));
    if (unknown.length)
      throw new Usage(`Unknown option(s) for ${kebab(op.operationId)}: ${unknown.map((u) => `--${u}`).join(', ')}`);

    let body: string | null = null;
    if (op.body) {
      const file = flags.get('data-file');
      const raw = flags.get('data') ?? (file === '-' ? await d.readStdin() : file ? await d.readFile(file) : '{}');
      try {
        body = JSON.stringify(JSON.parse(raw));
      } catch {
        throw new Usage('--data must be JSON');
      }
    } else if (flags.has('data') || flags.has('data-file'))
      throw new Usage(`${kebab(op.operationId)} takes no request body`);

    const base = (flags.get('url') ?? d.env.OPENDC_URL ?? 'https://localhost:8443').replace(/\/+$/, '');
    const token = flags.get('token') ?? d.env.OPENDC_TOKEN;
    const caFile = flags.get('ca') ?? d.env.OPENDC_CA;
    const ca = caFile ? await d.readFile(caFile) : null;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    else if (op.auth !== 'public')
      throw new Usage('This operation needs an API token: --token or OPENDC_TOKEN (console → Account → API tokens)');
    if (body !== null) headers['content-type'] = 'application/json';

    const qs = query.toString();
    const res = await d.transport({ method: op.method, url: `${base}${path}${qs ? `?${qs}` : ''}`, headers, body, ca });
    if (res.status >= 400) {
      let e: { code?: string; message?: string; fix?: string } = {};
      try {
        e = JSON.parse(res.body) as typeof e;
      } catch {
        // not JSON
      }
      d.err(
        e.message
          ? `Error (${e.code ?? String(res.status)}): ${e.message}\nFix: ${e.fix ?? ''}`
          : `HTTP ${String(res.status)}: ${res.body.slice(0, 500)}`,
      );
      return 1;
    }
    if (res.contentType.includes('application/json') && res.body) d.out(JSON.stringify(JSON.parse(res.body), null, 2));
    else d.out(res.body);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      d.err(e.message);
      return 2;
    }
    if (e instanceof PlatformError) throw e;
    d.err(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export async function readFileText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
