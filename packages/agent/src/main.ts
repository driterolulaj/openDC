#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * opendc-agent entry point. Under systemd it receives its three sockets by socket activation
 * (opendc-agent.socket, FileDescriptorName=api|watch|cli). For development it can listen on paths:
 *   opendc-agent --listen api=/tmp/agent-api.sock --listen cli=/tmp/agent-cli.sock
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { detectActions } from '@opendc/os';
import { agentSocket, nodeRoles, type AgentSocket, type NodeRole } from '@opendc/shared/manifest';
import { loadAllowlist } from './allowlist.ts';
import { AgentServer, type LogLine } from './server.ts';
import { initSecrets } from './init-secrets.ts';
import { SambaLocal } from './samba/local.ts';
import { runSdPropIfPdc } from './samba/sdprop.ts';
import { Pki } from './samba/pki.ts';
import { SetupToken } from './setup/token.ts';
import { NodeStateFile, SecretFiles } from './state.ts';

const SD_LISTEN_FDS_START = 3;

function log(line: LogLine): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...line }) + '\n');
}

async function readCredential(name: string): Promise<Buffer | null> {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  try {
    return await readFile(`${dir}/${name}`);
  } catch {
    return null;
  }
}

/** Sockets passed by systemd: [{name, fd}]. */
function inheritedSockets(): { name: AgentSocket; fd: number }[] {
  if (process.env.LISTEN_PID !== String(process.pid)) return [];
  const count = Number(process.env.LISTEN_FDS ?? '0');
  const names = (process.env.LISTEN_FDNAMES ?? '').split(':');
  const out: { name: AgentSocket; fd: number }[] = [];
  for (let i = 0; i < count; i++) {
    const parsed = agentSocket.safeParse(names[i]);
    if (!parsed.success)
      throw new Error(`Unexpected socket name "${names[i] ?? ''}"; set FileDescriptorName=api|watch|cli`);
    out.push({ name: parsed.data, fd: SD_LISTEN_FDS_START + i });
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      listen: { type: 'string', multiple: true },
      role: { type: 'string' },
      'init-secrets': { type: 'boolean' },
      sdprop: { type: 'boolean' },
      'pki-maintain': { type: 'boolean' },
    },
  });
  if (values.sdprop) {
    // opendc-sdprop.timer: protect tier-0 accounts on the PDC emulator
    const os = await detectActions();
    const r = await runSdPropIfPdc(new SambaLocal(os), (await os.system.info()).hostname);
    log({ level: 'info', msg: 'sdprop', ...r });
    return;
  }
  if (values['pki-maintain']) {
    // opendc-pki.timer: renew this node's certificates, install its issuing CA, refresh its CRL (ADR-0007)
    const os = await detectActions();
    const samba = new SambaLocal(os);
    if (!(await samba.provisioned())) return;
    const r = await new Pki(os, samba).maintain();
    log({ level: 'info', msg: 'pki maintenance', ...r });
    return;
  }
  if (values['init-secrets']) {
    await initSecrets(await detectActions(), (msg, extra) => {
      log({ level: 'info', msg, ...extra });
    });
    return;
  }
  const allowlist = loadAllowlist();
  const os = await detectActions();
  const node = new NodeStateFile(os.facts.paths.etc);
  const role =
    values.role && (nodeRoles as readonly string[]).includes(values.role)
      ? (values.role as NodeRole)
      : ((await node.role()) ?? 'managed-node');
  const confirmKey = await readCredential('confirm-hmac');
  const agent = new AgentServer({
    os,
    allowlist,
    role,
    confirmKey,
    log,
    node,
    secrets: new SecretFiles(os.facts.paths.secrets),
    token: new SetupToken(os.facts.paths.secrets),
  });

  const listeners = inheritedSockets().map((s) => ({ name: s.name, target: { fd: s.fd } as const }));
  for (const spec of values.listen ?? []) {
    const [name, path] = spec.split('=', 2);
    const parsed = agentSocket.safeParse(name);
    if (!parsed.success || !path) throw new Error(`--listen expects api|watch|cli=<path>, got ${spec}`);
    listeners.push({ name: parsed.data, target: { path } as never });
  }
  if (listeners.length === 0) throw new Error('No sockets: start through opendc-agent.socket or pass --listen');

  for (const l of listeners) {
    const server = agent.createServer(l.name);
    server.listen(l.target);
    log({
      level: 'info',
      msg: 'listening',
      socket: l.name,
      role,
      adapter: os.facts.adapter,
      release: os.facts.release.prettyName,
      confirmations: confirmKey ? 'enabled' : 'disabled',
    });
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log({ level: 'info', msg: `stopping on ${sig}` });
      process.exit(0);
    });
  }
}

main().catch((e: unknown) => {
  log({ level: 'error', msg: 'agent failed to start', error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
