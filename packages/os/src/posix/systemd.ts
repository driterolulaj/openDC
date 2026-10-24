// SPDX-License-Identifier: AGPL-3.0-only
/** systemd service control shared by all Linux adapters. */
import type { Exec } from '../exec.ts';
import type { ServiceActions, ServiceStatus } from '../types.ts';

export function parseSystemctlShow(text: string): ServiceStatus {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const since = kv.get('ActiveEnterTimestamp');
  const enabledState = kv.get('UnitFileState') ?? '';
  return {
    active: kv.get('ActiveState') ?? 'unknown',
    sub: kv.get('SubState') ?? 'unknown',
    enabled:
      enabledState === 'enabled' ||
      enabledState === 'enabled-runtime' ||
      enabledState === 'static' ||
      enabledState === 'alias',
    ...(since && since !== 'n/a' ? { since } : {}),
  };
}

export class SystemdServiceActions implements ServiceActions {
  readonly #exec: Exec;
  readonly #systemctl: () => Promise<string>;
  readonly #unitName: (unit: string) => string;

  constructor(exec: Exec, systemctl: () => Promise<string>, unitName: (unit: string) => string) {
    this.#exec = exec;
    this.#systemctl = systemctl;
    this.#unitName = unitName;
  }

  async status(unit: string): Promise<ServiceStatus> {
    const r = await this.#exec(
      await this.#systemctl(),
      [
        'show',
        '--no-pager',
        '--property=ActiveState,SubState,UnitFileState,ActiveEnterTimestamp',
        '--',
        this.#unitName(unit),
      ],
      { timeoutMs: 15_000 },
    );
    return parseSystemctlShow(r.stdout);
  }

  async #verb(verb: 'start' | 'stop' | 'restart' | 'reload', unit: string): Promise<void> {
    await this.#exec(await this.#systemctl(), [verb, '--no-block', '--', this.#unitName(unit)], { timeoutMs: 90_000 });
  }

  start(unit: string): Promise<void> {
    return this.#verb('start', unit);
  }
  stop(unit: string): Promise<void> {
    return this.#verb('stop', unit);
  }
  restart(unit: string): Promise<void> {
    return this.#verb('restart', unit);
  }
  reload(unit: string): Promise<void> {
    return this.#verb('reload', unit);
  }
}
