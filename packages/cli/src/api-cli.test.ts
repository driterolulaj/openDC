// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCommand, findOperation, kebab, type ApiCliDeps } from './api-cli.ts';
import { operations } from './generated/operations.ts';

function deps(response = { status: 200, contentType: 'application/json', body: '{"ok":true}' }) {
  const calls: Parameters<ApiCliDeps['transport']>[0][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: ApiCliDeps = {
    transport: async (o) => {
      calls.push(o);
      return response;
    },
    env: { OPENDC_URL: 'https://dc1.example.test:8443/', OPENDC_TOKEN: 'odc_t' },
    readFile: async (p) => (p === 'body.json' ? '{"sam":"alice"}' : 'PEM'),
    readStdin: async () => '{"sam":"bob"}',
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  return { d, calls, out, err };
}

test('every route is reachable from the CLI, by operationId or kebab-case', () => {
  assert.ok(operations.length > 50);
  assert.equal(kebab('listDirectoryObjects'), 'list-directory-objects');
  assert.equal(findOperation('list-directory-objects')?.path, '/api/v1/directory/objects');
  assert.equal(findOperation('CREATEUSER')?.method, 'POST');
});

test('builds the request: path params, query flags, JSON body, bearer token, CA', async () => {
  const a = deps();
  assert.equal(await apiCommand(['list-directory-objects', '--types', 'user', '--q=ali', '--ca', 'ca.pem'], a.d), 0);
  assert.equal(a.calls[0]?.url, 'https://dc1.example.test:8443/api/v1/directory/objects?types=user&q=ali');
  assert.equal(a.calls[0]?.headers.authorization, 'Bearer odc_t');
  assert.equal(a.calls[0]?.ca, 'PEM');
  assert.equal(a.out[0], '{\n  "ok": true\n}');

  const b = deps();
  assert.equal(await apiCommand(['create-user', '--data-file', 'body.json'], b.d), 0);
  assert.equal(b.calls[0]?.body, '{"sam":"alice"}');
  const c = deps();
  assert.equal(await apiCommand(['create-user', '--data-file', '-'], c.d), 0);
  assert.equal(c.calls[0]?.body, '{"sam":"bob"}');
  const g = deps();
  assert.equal(await apiCommand(['get-directory-object', '0cbc0cd0-4ea5-4cdd-b2ee-80daa08813ac'], g.d), 0);
  assert.equal(
    g.calls[0]?.url,
    'https://dc1.example.test:8443/api/v1/directory/objects/0cbc0cd0-4ea5-4cdd-b2ee-80daa08813ac',
  );
});

test('usage errors and API errors', async () => {
  const a = deps();
  assert.equal(await apiCommand(['get-directory-object'], a.d), 2, 'missing path argument');
  assert.equal(await apiCommand(['list-directory-objects', '--nope', '1'], a.d), 2);
  assert.equal(await apiCommand(['create-user', '--data', '{bad'], a.d), 2);
  assert.equal(await apiCommand(['no-such-op'], a.d), 2);
  assert.equal(a.calls.length, 0);
  const e = deps({
    status: 403,
    contentType: 'application/json',
    body: '{"code":"auth.forbidden","message":"No.","fix":"Ask."}',
  });
  assert.equal(await apiCommand(['list-audit'], e.d), 1);
  assert.match(e.err[0] ?? '', /auth.forbidden.*No\.\nFix: Ask\./s);
  const noToken = deps();
  noToken.d.env = {};
  assert.equal(await apiCommand(['list-audit'], noToken.d), 2);
  assert.equal(await apiCommand(['health'], noToken.d), 0, 'public operations need no token');
});

test('api list shows every operation with its arguments', async () => {
  const a = deps();
  await apiCommand(['list', 'directory/users'], a.d);
  assert.ok(a.out.some((l) => l.startsWith('create-user')));
  assert.ok(a.out.some((l) => l.includes('reset-user-password') && l.includes('<guid>')));
});
