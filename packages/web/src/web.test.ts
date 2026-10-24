// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import en from './locales/en.json';
import de from './locales/de.json';
import { api, ApiFailure, setCsrfToken } from './api.ts';

function keys(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix];
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('locales', () => {
  it('en and de have exactly the same keys', () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });
  it('placeholders match between languages', () => {
    const ph = (s: unknown): string[] => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
    const flat = (o: unknown, p = ''): [string, unknown][] =>
      o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [[p, o]];
    const deMap = new Map(flat(de));
    for (const [k, v] of flat(en)) expect(ph(deMap.get(k)), k).toEqual(ph(v));
  });
});

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('sends the CSRF token only on state-changing requests', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    setCsrfToken('tok');
    await api('/x', { schema: z.object({ ok: z.boolean() }) });
    await api('/x', { method: 'POST', body: { a: 1 }, schema: z.object({ ok: z.boolean() }) });
    const h0 = calls[0]?.init.headers as Record<string, string>;
    const h1 = calls[1]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe('/api/v1/x');
    expect(h0['x-csrf-token']).toBeUndefined();
    expect(h1['x-csrf-token']).toBe('tok');
    expect(h1['content-type']).toBe('application/json');
    expect(calls[1]?.init.credentials).toBe('same-origin');
  });

  it('turns error bodies into ApiFailure with the catalogue code', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ code: 'auth.forbidden', message: 'm', fix: 'f', params: { permission: 'core.audit.read' } }),
          { status: 403 },
        ),
    );
    await expect(api('/audit', { schema: z.object({}) })).rejects.toMatchObject({
      status: 403,
      body: { code: 'auth.forbidden' },
    });
    vi.stubGlobal('fetch', async () => new Response('not json', { status: 502, statusText: 'Bad Gateway' }));
    const e = await api('/x', { schema: z.object({}) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiFailure);
    expect((e as ApiFailure).body.code).toBe('internal');
  });
});
