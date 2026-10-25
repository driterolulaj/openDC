// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './gen.ts';

/** Writes a throwaway repo root with one module "demo" and returns the generator issues for it. */
async function issuesFor(
  manifest: Record<string, unknown>,
  opts: { de?: object; extraFiles?: Record<string, string> } = {},
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'opendc-gen-'));
  try {
    const dir = join(root, 'modules', 'demo');
    mkdirSync(join(dir, 'i18n'), { recursive: true });
    writeFileSync(join(dir, 'manifest.ts'), `export default ${JSON.stringify(manifest)};\n`);
    const en = { module: { title: 'Demo', description: 'Demo' }, perm: { x: 'X' } };
    writeFileSync(join(dir, 'i18n', 'en.json'), JSON.stringify(en));
    writeFileSync(join(dir, 'i18n', 'de.json'), JSON.stringify(opts.de ?? en));
    for (const [f, c] of Object.entries(opts.extraFiles ?? {})) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    return (await generate(root)).issues;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const base = {
  manifestVersion: 1,
  id: 'demo',
  version: '0.1.0',
  title: 'demo:module.title',
  description: 'demo:module.description',
  roles: ['any'],
  optional: true,
  permissions: [{ name: 'demo.thing.read', title: 'demo:perm.x', scope: 'global' }],
  i18n: { namespaces: ['demo'] },
};

test('a valid manifest has no issues', async () => {
  assert.deepEqual(await issuesFor(base), []);
});

test('schema violations are reported with their path', async () => {
  const issues = await issuesFor({ ...base, roles: ['root'], extra: true });
  assert.ok(
    issues.some((i) => i.includes('roles')),
    issues.join('\n'),
  );
  assert.ok(
    issues.some((i) => i.toLowerCase().includes('unrecognized')),
    issues.join('\n'),
  );
});

test('permission, file and op rules', async () => {
  const issues = await issuesFor({
    ...base,
    permissions: [{ name: 'other.thing.read', title: 'demo:perm.x', scope: 'global', implies: ['demo.nope.read'] }],
    agentOperations: [
      { op: 'samba.tool', from: ['api'] },
      { op: 'file.writeManaged', from: ['api'] },
      { op: 'samba.demote', from: ['cli'] },
    ],
    managed: { files: [{ fileId: 'other.file', pathKey: 'x.y', owner: 'root', mode: '0644', comment: 'hash' }] },
  });
  const expect = [
    'permission other.thing.read must start with "demo."',
    'implies unknown demo.nope.read',
    'samba.tool is not in the catalogue',
    'file.writeManaged is not available on the api socket',
    'samba.demote is catalogued (phase 4) but not implemented yet',
    'managed file other.file must start with "demo."',
  ];
  for (const e of expect)
    assert.ok(
      issues.some((i) => i.includes(e)),
      `${e}\n---\n${issues.join('\n')}`,
    );
});

test('templates need a managed file, known keys and managed units', async () => {
  const issues = await issuesFor(
    {
      ...base,
      registry: {
        keysEntry: './registry/keys.ts',
        templates: [
          {
            fileId: 'demo.conf',
            entry: './registry/tpl.ts',
            reads: ['demo.missing.*'],
            roles: ['any'],
            onChange: [{ kind: 'service', action: 'restart', unit: 'nginx' }],
          },
        ],
      },
    },
    {
      extraFiles: {
        'registry/keys.ts':
          "export const keys = [{ name: 'demo.a', schema: { safeParse: () => ({ success: false }) }, default: 1, description: 'demo:perm.x', policySettable: false }];\n",
        'registry/tpl.ts': 'export default () => "";\n',
      },
    },
  );
  for (const e of [
    'template demo.conf has no managed.files entry',
    'reads unknown key demo.missing.*',
    'restarts unit nginx',
    'default does not match its schema',
  ]) {
    assert.ok(
      issues.some((i) => i.includes(e)),
      `${e}\n---\n${issues.join('\n')}`,
    );
  }
});

test('missing entries, bad watcher filters and missing translations', async () => {
  const issues = await issuesFor(
    {
      ...base,
      api: { entry: './api/missing.ts' },
      watchers: [
        {
          id: 'w',
          base: '{platform}',
          scope: 'sub',
          filter: '(objectClass=x',
          attributes: [],
          roles: ['any'],
          entry: './api/missing.ts',
        },
      ],
    },
    { de: { module: { title: 'Demo' }, perm: {} } },
  );
  for (const e of [
    'entry ./api/missing.ts does not exist',
    'watcher w',
    'demo:module.description missing in de',
    'demo:perm.x missing in de',
  ]) {
    assert.ok(
      issues.some((i) => i.includes(e)),
      `${e}\n---\n${issues.join('\n')}`,
    );
  }
});

test('the real repository manifests are valid', async () => {
  const { issues, files } = await generate(join(import.meta.dirname, '../../../..'));
  assert.deepEqual(issues, []);
  assert.ok(files.size >= 6);
});
