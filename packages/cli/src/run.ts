// SPDX-License-Identifier: AGPL-3.0-only
/** Command dispatch, separated from main.ts so tests can run commands against a fake agent. */
import type { TFunction } from 'i18next';
import { PlatformError, isPlatformError, platformVersion } from '@opendc/shared';
import type { AgentClient } from '@opendc/shared/agent';
import { Registry, RegistryService, type RegistryAgent, type TemplateEntry } from '@opendc/registry';
import type { RegistryKeyDefinition } from '@opendc/shared/manifest';

export interface CliDeps {
  t: TFunction;
  agent: RegistryAgent;
  client: Pick<AgentClient, 'call'>;
  keys: RegistryKeyDefinition[];
  templates: readonly TemplateEntry[];
  out: (s: string) => void;
  err: (s: string) => void;
  user: string;
}

/** Interprets a CLI value: JSON when it parses and validates, otherwise the raw string. */
export function parseValue(reg: Registry, key: string, raw: string): unknown {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(raw));
  } catch {
    // not JSON
  }
  candidates.push(raw);
  for (const c of candidates) {
    try {
      return reg.validate(key, c);
    } catch {
      // try the next interpretation
    }
  }
  return reg.validate(key, candidates[0]);
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export async function run(argv: string[], d: CliDeps): Promise<number> {
  const json = argv.includes('--json');
  const forced = argv.includes('--forced');
  const explain = argv.includes('--explain');
  const args = argv.filter((a) => !a.startsWith('--'));
  const [cmd, sub, ...rest] = args;
  const { t } = d;
  const need = (v: string | undefined, name: string): string => {
    if (v === undefined) throw new UsageError(t('missing-arg', { name }));
    return v;
  };
  const emit = (data: unknown, text: string): void => {
    d.out(json ? JSON.stringify(data, null, 2) : text);
  };

  try {
    if (!cmd || cmd === 'help' || argv.includes('--help')) {
      d.out(t('usage'));
      return cmd || argv.includes('--help') ? 0 : 2;
    }
    if (cmd === 'version') {
      emit({ version: platformVersion }, platformVersion);
      return 0;
    }
    if (cmd === 'agent' && sub === 'info') {
      const info = await d.client.call('system.info', {}, { actor: { name: d.user, via: 'cli' } });
      emit(
        info,
        `${info.fqdn} (${info.role})\n${info.os.prettyName}, kernel ${info.kernel}, ${String(info.cpus)} CPU\nagent ${info.agentVersion}`,
      );
      return 0;
    }
    if (cmd !== 'registry') throw new UsageError(t('unknown-command', { command: cmd }));

    const info = await d.client.call('system.info', {}, { actor: { name: d.user, via: 'cli' } });
    const svc = new RegistryService({
      agent: d.agent,
      keys: new Registry(d.keys),
      templates: d.templates,
      node: { hostname: info.hostname, fqdn: info.fqdn, role: info.role },
      holder: `cli:${d.user}`,
    });
    const layer = forced ? 'forced' : 'local';

    switch (sub) {
      case 'get': {
        const key = need(rest[0], 'key');
        const e = (await svc.load()).explain(key);
        if (!explain) {
          emit(e.value, show(e.value));
          return 0;
        }
        const lines = [t('explain', { key, value: show(e.value), layer: e.layer })];
        for (const def of e.defined)
          lines.push(
            t('explain-layer', { layer: def.layer, value: show(def.value), ignored: def.valid ? '' : t('ignored') }),
          );
        emit(e, lines.join('\n'));
        return 0;
      }
      case 'set': {
        const key = need(rest[0], 'key');
        const raw = need(rest[1], 'value');
        const value = parseValue(await svc.load(), key, raw);
        const report = await svc.set(key, value, layer);
        emit(report, `${t('set-done', { key, layer })}\n${commitLine(t, report)}`);
        return 0;
      }
      case 'unset': {
        const key = need(rest[0], 'key');
        const report = await svc.set(key, undefined, layer);
        emit(report, `${t('unset-done', { key, layer })}\n${commitLine(t, report)}`);
        return 0;
      }
      case 'list': {
        const reg = await svc.load();
        const rows = reg.keys().map((k) => {
          const e = reg.explain(k);
          return { key: k, value: e.value, layer: e.layer };
        });
        const invalid = reg.invalidValues();
        const text = rows.map((r) => `${r.key} = ${show(r.value)}  [${r.layer}]`).join('\n');
        const bad = invalid.length
          ? `\n\n${t('invalid-values')}\n${invalid.map((i) => t('invalid-line', { ...i })).join('\n')}`
          : '';
        emit({ keys: rows, invalid }, text + bad);
        return 0;
      }
      case 'describe': {
        const key = need(rest[0], 'key');
        const def = new Registry(d.keys).definition(key);
        const [ns, path] = def.description.split(':');
        emit(
          {
            key,
            description: t(`${ns ?? ''}:${path ?? ''}`),
            default: def.default,
            policySettable: def.policySettable,
            effect: def.effect ?? 'none',
          },
          t('describe', {
            key,
            description: t(`${ns ?? ''}:${path ?? ''}`),
            default: show(def.default),
            policy: def.policySettable ? t('yes') : t('no'),
            effect: def.effect ?? 'none',
          }),
        );
        return 0;
      }
      case 'commit': {
        const report = await svc.commit(rest.length ? rest : undefined);
        emit(report, commitLine(t, report));
        return 0;
      }
      case 'drift': {
        const drift = await svc.drift();
        if (!drift.length) {
          emit({ drift }, t('drift-none'));
          return 0;
        }
        emit(
          { drift },
          [
            t('drift-found', { count: drift.length }),
            ...drift.map((x) => t('drift-line', { fileId: x.fileId, state: t(`drift-${x.state}`) })),
          ].join('\n'),
        );
        return 1;
      }
      default:
        throw new UsageError(t('unknown-command', { command: `registry ${sub ?? ''}`.trim() }));
    }
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(e.message);
      return 2;
    }
    const pe = isPlatformError(e) ? e : new PlatformError('internal', { requestId: 'cli' }, { cause: e });
    if (json) d.err(JSON.stringify(pe.toBody(), null, 2));
    else
      d.err(
        t('error', { message: t(`errors:${pe.code}.message`, pe.params), fix: t(`errors:${pe.code}.fix`, pe.params) }),
      );
    if (!isPlatformError(e) && process.env.OPENDC_DEBUG) d.err(String((e as Error).stack));
    return 1;
  }
}

class UsageError extends Error {}

function commitLine(t: TFunction, r: { rendered: string[]; changed: string[]; handlers: string[] }): string {
  return t('commit-done', {
    rendered: r.rendered.length,
    changed: r.changed.length,
    handlers: r.handlers.length ? r.handlers.join(', ') : t('none'),
  });
}
