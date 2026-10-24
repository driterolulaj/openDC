// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Release packaging (ADR-0016). Run on a Linux build host after `npm ci --ignore-scripts && npm run build`:
 *   node packaging/build.ts [--arch x64|arm64] [--version 0.1.0]
 * Produces in packaging/out/: opendc-common_<v>_<arch>.deb, opendc-web_<v>_all.deb and
 * opendc-<v>-linux-<arch>.tar.gz (with install.sh). The Node runtime and nfpm are pinned and
 * checksum-verified. Only production dependencies from the committed lockfile are shipped.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const CACHE = join(ROOT, 'packaging', '.cache');
const OUT = join(ROOT, 'packaging', 'out');

const NODE = {
  version: '24.22.1',
  sha256: {
    x64: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
    arm64: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
  },
} as const;
const NFPM = { version: '2.47.0', sha256: '0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783' } as const;

const { values } = parseArgs({ options: { arch: { type: 'string', default: 'x64' }, version: { type: 'string' } } });
const arch = values.arch === 'arm64' ? 'arm64' : 'x64';
const debArch = arch === 'arm64' ? 'arm64' : 'amd64';

async function sh(cmd: string, args: string[], cwd = ROOT): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, shell: false, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

async function fetchVerified(url: string, file: string, want: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (!existsSync(path) || sha256(path) !== want) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${url} (${String(res.status)})`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(path);
  if (got !== want) throw new Error(`Checksum mismatch for ${file}: expected ${want}, got ${got}`);
  return path;
}

async function version(): Promise<string> {
  if (values.version) return values.version;
  const base = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const rev = (await sh('git', ['rev-parse', '--short=8', 'HEAD']).catch(() => 'nogit')).trim();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  // "~dev" sorts before the release in dpkg version order.
  return `${base}~dev${stamp}+g${rev}`;
}

/** Copies a workspace package: package.json plus dist/ without tests, declarations and build info. */
function copyWorkspace(src: string, dest: string, extra: string[] = []): void {
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
  const skip = (p: string): boolean =>
    /\.test\.(js|js\.map)$|\.d\.ts(\.map)?$|\.tsbuildinfo$|\.lab\.js(\.map)?$/.test(p);
  cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true, filter: (p) => !skip(p) });
  for (const e of extra) if (existsSync(join(src, e))) cpSync(join(src, e), join(dest, e), { recursive: true });
}

async function stageApp(appDir: string): Promise<void> {
  const nm = join(appDir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  const runtime = ['@opendc/api', '@opendc/agent', '@opendc/watcher', '@opendc/cli'];
  const out = await sh('npm', ['ls', '--omit=dev', '--all', '--parseable', ...runtime.flatMap((w) => ['-w', w])]);
  const rootNm = join(ROOT, 'node_modules') + sep;
  const paths = [
    ...new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ].sort();
  const copied: string[] = [];
  for (const p of paths) {
    if (p === ROOT) continue;
    if (p.startsWith(rootNm)) {
      // third-party package (top level or nested); nested ones arrive with their parent
      if (copied.some((c) => p.startsWith(c + sep))) continue;
      const rel = relative(join(ROOT, 'node_modules'), p);
      cpSync(p, join(nm, rel), { recursive: true, dereference: false });
      copied.push(p);
    } else {
      // a workspace package (npm reports its real path)
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')) as { name: string };
      if (pkg.name === '@opendc/web') continue;
      copyWorkspace(
        p,
        join(nm, pkg.name),
        pkg.name === '@opendc/modules'
          ? readdirSync(p)
              .filter((d) => existsSync(join(p, d, 'i18n')))
              .map((d) => join(d, 'i18n'))
          : [],
      );
    }
  }
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'opendc-app', private: true, type: 'module', license: 'AGPL-3.0-only' }, null, 2) + '\n',
  );
}

function nfpmConfig(
  name: string,
  v: string,
  a: string,
  description: string,
  contents: unknown[],
  extra: Record<string, unknown>,
): string {
  // JSON is valid YAML, so no YAML library is needed here.
  return JSON.stringify(
    {
      name,
      arch: a,
      platform: 'linux',
      version: v,
      version_schema: 'none',
      section: 'admin',
      priority: 'optional',
      maintainer: 'OpenDC <maintainers@opendc.invalid>',
      description,
      vendor: 'OpenDC',
      license: 'AGPL-3.0-only',
      contents,
      ...extra,
    },
    null,
    2,
  );
}

async function main(): Promise<void> {
  if (process.platform !== 'linux')
    throw new Error('Build packages on Linux (the lab build VM or CI); file modes and ownership matter.');
  for (const d of ['packages/api/dist', 'packages/agent/dist', 'packages/web/dist']) {
    if (!existsSync(join(ROOT, d))) throw new Error(`${d} is missing: run npm run build first`);
  }
  const v = await version();
  rmSync(OUT, { recursive: true, force: true });
  const stage = join(OUT, 'stage');
  const common = join(stage, 'common');
  const web = join(stage, 'web');

  // Node runtime: only the binary and its license.
  const nodeTar = await fetchVerified(
    `https://nodejs.org/dist/v${NODE.version}/node-v${NODE.version}-linux-${arch}.tar.xz`,
    `node-v${NODE.version}-linux-${arch}.tar.xz`,
    NODE.sha256[arch],
  );
  const nodeDir = join(common, 'usr/lib/opendc/node');
  mkdirSync(join(nodeDir, 'bin'), { recursive: true });
  const top = `node-v${NODE.version}-linux-${arch}`;
  await sh('tar', ['-xJf', nodeTar, '-C', nodeDir, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`]);

  await stageApp(join(common, 'usr/lib/opendc/app'));
  const p = (rel: string): string => join(ROOT, 'packaging', rel);
  const place = (src: string, dest: string, mode = 0o644): void => {
    mkdirSync(dirname(join(common, dest)), { recursive: true });
    cpSync(p(src), join(common, dest));
    chmodSync(join(common, dest), mode);
  };
  for (const unit of readdirSync(p('systemd'))) place(join('systemd', unit), join('usr/lib/systemd/system', unit));
  place('sysusers.d/opendc.conf', 'usr/lib/sysusers.d/opendc.conf');
  place('tmpfiles.d/opendc.conf', 'usr/lib/tmpfiles.d/opendc.conf');
  place('bin/opendc', 'usr/bin/opendc', 0o755);
  mkdirSync(join(common, 'usr/share/doc/opendc-common'), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(common, 'usr/share/doc/opendc-common/copyright'));

  mkdirSync(join(web, 'usr/lib/opendc'), { recursive: true });
  cpSync(join(ROOT, 'packages/web/dist'), join(web, 'usr/lib/opendc/web'), {
    recursive: true,
    filter: (f) => !f.endsWith('.map'),
  });

  const tree = (dir: string): unknown[] =>
    readdirSync(dir).map((entry) => ({ src: join(dir, entry), dst: `/${entry}`, type: 'tree' }));
  const commonYaml = join(OUT, 'nfpm-common.yaml');
  writeFileSync(
    commonYaml,
    nfpmConfig(
      'opendc-common',
      v,
      debArch,
      'OpenDC platform runtime: agent, API, watcher, CLI and the bundled Node.js',
      tree(common),
      {
        depends: ['systemd (>= 247)', 'openssl', 'ca-certificates', 'hostname'],
        scripts: {
          postinstall: p('scripts/postinstall.sh'),
          preremove: p('scripts/preremove.sh'),
          postremove: p('scripts/postremove.sh'),
        },
      },
    ),
  );
  const webYaml = join(OUT, 'nfpm-web.yaml');
  writeFileSync(
    webYaml,
    nfpmConfig('opendc-web', v, 'all', 'OpenDC web console (static assets)', tree(web), {
      depends: [`opendc-common (= ${v})`],
    }),
  );

  const nfpmTar = await fetchVerified(
    `https://github.com/goreleaser/nfpm/releases/download/v${NFPM.version}/nfpm_${NFPM.version}_Linux_x86_64.tar.gz`,
    `nfpm_${NFPM.version}_Linux_x86_64.tar.gz`,
    NFPM.sha256,
  );
  await sh('tar', ['-xzf', nfpmTar, '-C', CACHE, 'nfpm']);
  const nfpm = join(CACHE, 'nfpm');
  for (const y of [commonYaml, webYaml])
    await sh(nfpm, ['package', '--config', y, '--packager', 'deb', '--target', OUT]);

  // Tarball + install.sh for hosts without a package manager we support yet.
  const tarRoot = join(OUT, `opendc-${v}`);
  const payload = join(OUT, 'payload');
  cpSync(common, payload, { recursive: true });
  cpSync(web, payload, { recursive: true });
  mkdirSync(tarRoot, { recursive: true });
  await sh('tar', ['--owner=0', '--group=0', '-czf', join(tarRoot, 'payload.tar.gz'), '-C', payload, '.']);
  for (const s of ['postinstall.sh', 'preremove.sh', 'postremove.sh']) cpSync(p(join('scripts', s)), join(tarRoot, s));
  cpSync(p('install.sh'), join(tarRoot, 'install.sh'));
  chmodSync(join(tarRoot, 'install.sh'), 0o755);
  const tgz = join(OUT, `opendc-${v}-linux-${arch}.tar.gz`);
  await sh('tar', ['--owner=0', '--group=0', '-czf', tgz, '-C', OUT, basename(tarRoot)]);
  rmSync(payload, { recursive: true, force: true });

  const artifacts = readdirSync(OUT).filter((f) => /\.(deb|tar\.gz)$/.test(f));
  const sums = artifacts.map((f) => `${sha256(join(OUT, f))}  ${f}`).join('\n') + '\n';
  writeFileSync(join(OUT, 'SHA256SUMS'), sums);
  for (const f of artifacts) console.log(`${f}  ${(statSync(join(OUT, f)).size / 1048576).toFixed(1)} MiB`);
}

await main();
