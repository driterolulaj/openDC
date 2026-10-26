// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `opendc setup` (ROADMAP Phase 2): the CLI counterpart of the setup wizard. Runs as root on the host being
 * set up and talks to the local agent's cli socket, so it works before any API or domain exists.
 *
 *   opendc setup status | token
 *   opendc setup preflight  primary-dc|dc  <options>
 *   opendc setup provision  --fqdn dc1.example.com --ip 10.0.0.11 --domain example.com [--netbios EXAMPLE]
 *                           [--forwarder 1.1.1.1]... [--ntp pool.ntp.org]... [--ntp-allow 10.0.0.0/24]...
 *                           [--schema 2016] [--level 2008_R2] [--site NAME] [--id-base 100000]
 *                           [--password-file FILE|-] [--confirm <domain>]
 *   opendc setup join       --fqdn dc2.example.com --ip 10.0.0.12 --domain example.com --dc 10.0.0.11
 *                           [--user Administrator] [--password-file FILE|-] [--forwarder ...] [--confirm <domain>]
 *
 * The admin password is read from a file, stdin ("-") or an interactive prompt, never from argv.
 */
import { parseArgs } from 'node:util';
import type { TFunction } from 'i18next';
import { PlatformError } from '@opendc/shared';
import { mintConfirmation, type AgentClient, type Progress } from '@opendc/shared/agent';
import {
  confirmationPhrase,
  defaultNetbios,
  joinArgs,
  memberJoinArgs,
  provisionArgs,
  type PreflightResult,
} from '@opendc/shared/domain';

export interface SetupIo {
  /** Reads a root-only secret file (setup token, HMAC key); null when missing or not readable. */
  readSecret(name: string): Promise<Buffer | null>;
  /** Reads a password: from a file, from stdin ("-"), or interactively without echo. */
  readPassword(source: string | undefined, prompt: string): Promise<string>;
  /** Asks a question on the terminal; null when stdin isn't interactive. */
  ask(prompt: string): Promise<string | null>;
}

export interface SetupDeps {
  t: TFunction;
  client: Pick<AgentClient, 'call'>;
  io: SetupIo;
  out: (s: string) => void;
  err: (s: string) => void;
  user: string;
  json: boolean;
}

const OPTIONS = {
  fqdn: { type: 'string' },
  ip: { type: 'string' },
  domain: { type: 'string' },
  netbios: { type: 'string' },
  forwarder: { type: 'string', multiple: true },
  ntp: { type: 'string', multiple: true },
  'ntp-allow': { type: 'string', multiple: true },
  schema: { type: 'string' },
  level: { type: 'string' },
  site: { type: 'string' },
  'id-base': { type: 'string' },
  dc: { type: 'string' },
  user: { type: 'string' },
  'password-file': { type: 'string' },
  'root-fingerprint': { type: 'string' },
  confirm: { type: 'string' },
  json: { type: 'boolean' },
} as const;

/** Check parameters with issue codes translated. */
function checkParams(t: TFunction, params: Record<string, string | number>): Record<string, string | number> {
  const issue = params.issue;
  return typeof issue === 'string' && issue ? { ...params, issue: t(`domain:setup.issue.${issue}`) } : params;
}

export function formatPreflight(t: TFunction, r: PreflightResult): string {
  const lines = r.checks.map((c) => {
    const p = checkParams(t, c.params);
    const text = t(`domain:setup.check.${c.id}.${c.status}`, p);
    const fix = c.status === 'pass' ? '' : `\n         ${t(`domain:setup.check.${c.id}.fix`, p)}`;
    return `  [${c.status.toUpperCase()}] ${text}${fix}`;
  });
  lines.push('', t(r.ok ? 'cli:preflight-ok' : 'cli:preflight-failed'));
  return lines.join('\n');
}

export async function setupCommand(argv: string[], d: SetupDeps): Promise<number> {
  const { t } = d;
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  const actor = { name: d.user, via: 'cli' as const };
  const json = d.json || values.json === true;
  const emit = (data: unknown, text: string): void => {
    d.out(json ? JSON.stringify(data, null, 2) : text);
  };

  if (sub === 'token') {
    const token = (await d.io.readSecret('setup-token'))?.toString('utf8').trim();
    if (!token) {
      d.err(t('cli:setup-no-token'));
      return 1;
    }
    emit({ token }, token);
    return 0;
  }
  if (sub === 'status') {
    const s = await d.client.call('setup.status', {}, { actor });
    emit(
      s,
      s.provisioned
        ? t('cli:setup-status-done', { role: s.role ?? '-', domain: s.domain ?? '-', fqdn: s.fqdn })
        : t('cli:setup-status-open', {
            fqdn: s.fqdn,
            os: s.os,
            addresses: s.addresses.map((a) => `${a.address}/${String(a.prefix)} (${a.iface})`).join(', '),
          }),
    );
    return 0;
  }

  const forwarders = values.forwarder ?? [];
  const common = {
    fqdn: values.fqdn ?? '',
    hostIp: values.ip ?? '',
    domain: values.domain ?? values.fqdn?.split('.').slice(1).join('.') ?? '',
    dnsForwarders: forwarders,
  };
  const preflight = async (role: 'primary-dc' | 'dc', extra: { netbiosDomain?: string; dcHost?: string }) => {
    const r = await d.client.call('setup.preflight', { role, ...common, ...extra }, { actor, timeoutMs: 180_000 });
    if (!json) d.out(formatPreflight(t, r));
    return r;
  };

  if (sub === 'preflight') {
    const role = positionals[0] === 'dc' ? 'dc' : 'primary-dc';
    const r = await preflight(role, {
      ...(role === 'primary-dc' ? { netbiosDomain: values.netbios ?? defaultNetbios(common.domain) } : {}),
      ...(values.dc ? { dcHost: values.dc } : {}),
    });
    if (json) emit(r, '');
    return r.ok ? 0 : 1;
  }

  if (sub !== 'provision' && sub !== 'join' && sub !== 'member')
    throw new PlatformError('validation.invalid', { issues: `setup ${sub ?? ''}` });

  const key = await d.io.readSecret('api-hmac');
  if (!key) {
    d.err(t('cli:setup-need-root'));
    return 1;
  }
  const progress = (p: Progress): void => {
    if (!json)
      d.out(
        `  … ${t(`domain:setup.step.${p.step}`, { defaultValue: p.step })}${p.percent === undefined ? '' : ` (${String(p.percent)}%)`}`,
      );
  };
  if (sub === 'member') {
    // a member server running OpenDC services (Phase 3; full enrolment in Phase 4)
    const user = values.user ?? 'Administrator';
    const password = await d.io.readPassword(values['password-file'], t('cli:setup-join-password-prompt', { user }));
    const parsed = memberJoinArgs.safeParse({
      fqdn: values.fqdn ?? '',
      hostIp: values.ip ?? '',
      dc: values.dc ?? '',
      rootFingerprint: values['root-fingerprint'] ?? '',
      username: user,
      password,
    });
    if (!parsed.success)
      throw new PlatformError('validation.invalid', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    const r = await d.client.call('samba.member.join', parsed.data, {
      actor,
      timeoutMs: 1_800_000,
      onProgress: progress,
    });
    emit(r, t('cli:setup-member-joined', { domain: r.domain, dc: r.dc, account: r.watchAccount }));
    return 0;
  }
  const confirm = async (domain: string): Promise<boolean> => {
    const phrase = confirmationPhrase({ domain });
    const typed = values.confirm ?? (await d.io.ask(t('cli:setup-confirm', { phrase })));
    if (typed?.trim().toLowerCase() === phrase) return true;
    d.err(t('cli:setup-confirm-mismatch', { phrase }));
    return false;
  };

  if (sub === 'provision') {
    const netbiosDomain = values.netbios ?? defaultNetbios(common.domain);
    const pre = await preflight('primary-dc', { netbiosDomain });
    if (!pre.ok) return 1;
    const adminPassword = await d.io.readPassword(values['password-file'], t('cli:setup-password-prompt'));
    const parsed = provisionArgs.safeParse({
      ...common,
      netbiosDomain,
      adminPassword,
      ntpServers: values.ntp ?? [],
      ntpAllow: values['ntp-allow'] ?? [],
      ...(values.schema ? { baseSchema: values.schema } : {}),
      ...(values.level ? { functionalLevel: values.level } : {}),
      ...(values.site ? { siteName: values.site } : {}),
      ...(values['id-base'] ? { idBase: Number(values['id-base']) } : {}),
    });
    if (!parsed.success) {
      throw new PlatformError('validation.invalid', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    if (!(await confirm(parsed.data.domain))) return 1;
    const confirmation = mintConfirmation(key, { op: 'samba.provision', args: parsed.data, actor: d.user });
    const r = await d.client.call('samba.provision', parsed.data, {
      actor,
      confirmation,
      timeoutMs: 3_600_000,
      onProgress: progress,
    });
    await restartServices(d);
    emit(r, t('cli:setup-provisioned', { domain: r.domain, fqdn: r.dcFqdn }));
    return 0;
  }

  // join
  const pre = await preflight('dc', values.dc ? { dcHost: values.dc } : {});
  if (!pre.ok) return 1;
  const user = values.user ?? 'Administrator';
  const password = await d.io.readPassword(values['password-file'], t('cli:setup-join-password-prompt', { user }));
  const parsed = joinArgs.safeParse({
    ...common,
    dcHost: values.dc ?? '',
    username: user,
    password,
    ntpServers: values.ntp ?? [],
    ntpAllow: values['ntp-allow'] ?? [],
    ...(values.site ? { siteName: values.site } : {}),
  });
  if (!parsed.success) {
    throw new PlatformError('validation.invalid', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  if (!(await confirm(parsed.data.domain))) return 1;
  const confirmation = mintConfirmation(key, { op: 'samba.join', args: parsed.data, actor: d.user });
  const r = await d.client.call('samba.join', parsed.data, {
    actor,
    confirmation,
    timeoutMs: 3_600_000,
    onProgress: progress,
  });
  await restartServices(d);
  emit(r, t('cli:setup-joined', { domain: r.domain, fqdn: r.dcFqdn }));
  return 0;
}

/** The API and watcher read their directory configuration and credentials at start. */
async function restartServices(d: SetupDeps): Promise<void> {
  const actor = { name: d.user, via: 'cli' as const };
  for (const unit of ['opendc-api', 'opendc-watcher']) {
    await d.client.call('service.restart', { unit }, { actor }).catch((e: unknown) => {
      d.err(String(e instanceof Error ? e.message : e));
    });
  }
}
