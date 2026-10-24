// SPDX-License-Identifier: AGPL-3.0-only
/** OpenAPI 3.1 document from the route table (ADR-0011 §3); JSON Schema comes from z.toJSONSchema. */
import { z } from 'zod';
import { errorBody } from '@opendc/shared/api';
import { platformVersion } from '@opendc/shared';
import type { AnyRoute } from './route.ts';

const schemaOf = (s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> => {
  const { $schema: _s, ...rest } = z.toJSONSchema(s, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return rest;
};

function parameters(r: AnyRoute): unknown[] {
  const out: unknown[] = [];
  const add = (where: 'path' | 'query', s: z.ZodType | undefined): void => {
    if (!s) return;
    const js = schemaOf(s, 'input') as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, schema] of Object.entries(js.properties ?? {})) {
      out.push({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema });
    }
  };
  add('path', r.params as z.ZodType | undefined);
  add('query', r.query as z.ZodType | undefined);
  return out;
}

export function buildOpenApi(routes: readonly AnyRoute[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of [...routes].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    if (!r.url.startsWith('/api/')) continue;
    const url = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const status = String(r.status ?? 200);
    const op: Record<string, unknown> = {
      operationId: r.operationId,
      summary: r.summary,
      tags: r.tags,
      'x-opendc-auth': typeof r.auth === 'object' ? { permission: r.auth.permission } : r.auth,
      ...(r.auth === 'public' ? { security: [] } : {}),
      parameters: parameters(r),
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemaOf(r.body as z.ZodType, 'input') } },
            },
          }
        : {}),
      responses: {
        [status]: r.stream
          ? { description: 'Server-sent events', content: { 'text/event-stream': { schema: { type: 'string' } } } }
          : { description: 'OK', content: { 'application/json': { schema: schemaOf(r.response, 'output') } } },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
    (paths[url] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenDC API',
      version: platformVersion.replace(/-dev$/, ''),
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: '__Host-opendc_sid' } },
      schemas: { Error: schemaOf(errorBody, 'output') },
    },
    security: [{ session: [] }],
    paths,
  };
}
