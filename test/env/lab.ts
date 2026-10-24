// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `npm run lab -- <command>` (ADR-0015): drives the VM lab from a developer machine. The lab runs on a
 * Proxmox VE gateway node (test/env/proxmox); this wrapper only copies files there and calls pve-lab.sh.
 *
 *   LAB_GATEWAY=root@<proxmox node> npm run lab -- sync                 copy test/env/proxmox to the gateway
 *   npm run lab -- up small | domain small | status | ssh sdc1 ...      any pve-lab.sh command
 *   npm run lab -- install sdc1 packaging/out                           install the built .deb packages in a VM
 *   npm run lab -- acceptance small packaging/out                       Phase 1 acceptance checks (3-5)
 *
 * Uses the OpenSSH client with argv arrays only; you are prompted for the gateway credentials as usual.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const REMOTE = '/root/opendc-lab';
const gateway = process.env.LAB_GATEWAY;

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false });
    p.on('exit', (code) => done(code ?? 1));
    p.on('error', (e) => {
      process.stderr.write(`${cmd}: ${e.message}\n`);
      done(127);
    });
  });
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    process.stdout.write(
      'usage: LAB_GATEWAY=root@<proxmox node> npm run lab -- sync | install <vm> <dir> | acceptance <topology> <dir> | <pve-lab.sh command>\n',
    );
    return cmd ? 0 : 2;
  }
  if (!gateway) {
    process.stderr.write(
      'Set LAB_GATEWAY=root@<proxmox node that runs the lab gateway> (see test/env/proxmox/README.md).\n',
    );
    return 2;
  }
  if (cmd === 'sync') {
    const code = await run('ssh', [gateway, 'mkdir', '-p', `${REMOTE}/src`]);
    if (code) return code;
    return run('scp', ['-r', '-q', join(ROOT, 'test/env/proxmox/.'), `${gateway}:${REMOTE}/src/`]);
  }
  if (cmd === 'install' || cmd === 'acceptance') {
    const [target, dir] = rest;
    if (!target || !dir) {
      process.stderr.write(
        `usage: npm run lab -- ${cmd} <${cmd === 'install' ? 'vm' : 'topology'}> <dir with .deb files>\n`,
      );
      return 2;
    }
    const debs = readdirSync(resolve(dir))
      .filter((f) => f.endsWith('.deb'))
      .map((f) => join(resolve(dir), f));
    if (!debs.length) {
      process.stderr.write(`no .deb files in ${dir}; run npm run package first\n`);
      return 2;
    }
    let code = await run('ssh', [gateway, 'rm', '-rf', `${REMOTE}/pkgs`, '&&', 'mkdir', '-p', `${REMOTE}/pkgs`]);
    if (!code) code = await run('scp', ['-q', ...debs, `${gateway}:${REMOTE}/pkgs/`]);
    if (code) return code;
    return run('ssh', [
      '-t',
      gateway,
      `${REMOTE}/src/pve-lab.sh`,
      cmd === 'install' ? 'install-pkgs' : 'acceptance',
      target,
      `${REMOTE}/pkgs`,
    ]);
  }
  return run('ssh', ['-t', gateway, `${REMOTE}/src/pve-lab.sh`, cmd, ...rest]);
}

process.exitCode = await main();
