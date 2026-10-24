#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `opendc` CLI. Phase 1 commands talk to the local agent over /run/opendc/agent-cli.sock (group
 * opendc-admin), so they work before the API exists and when it is down (agent-operations.md §1).
 */
import { userInfo } from 'node:os';
import { AgentClient } from '@opendc/shared/agent';
import { agentPort } from '@opendc/registry';
import { registryKeys, templates } from '@opendc/modules/generated/registry';
import { initI18n } from './i18n.ts';
import { run } from './run.ts';
import { moduleResources } from './resources.ts';

const DEFAULT_SOCKET = '/run/opendc/agent-cli.sock';

const argv = process.argv.slice(2);
const socketIdx = argv.indexOf('--socket');
const socket = socketIdx >= 0 ? argv[socketIdx + 1] : process.env.OPENDC_AGENT_SOCKET;
if (socketIdx >= 0) argv.splice(socketIdx, 2);

const user = process.env.SUDO_USER ?? userInfo().username;
const client = new AgentClient(socket ?? DEFAULT_SOCKET, 'cli');
const actor = { name: user, via: 'cli' as const };
const t = await initI18n(await moduleResources());

process.exitCode = await run(argv, {
  t,
  client,
  agent: agentPort(client, actor),
  keys: registryKeys,
  templates,
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  user,
});
