// SPDX-License-Identifier: AGPL-3.0-only
/** systemd service control shared by all Linux adapters. */
import type { Exec } from '../exec.ts';
import type { ServiceActions, ServiceStatus } from '../types.ts';

/**
 * Runs a command as a transient systemd service and waits for it (`systemd-run --wait --pipe`). Used for
 * work that the agent's hardened sandbox must not do itself, such as package installation. The command's
 * output is passed through; a non-zero exit fails like a direct exec.
 */
export async function runTransient(
  exec: Exec,
  systemdRun: string,
  argv: readonly string[],
  o: { env?: Record<string, string>; timeoutMs: number },
): Promise<string> {
  const env = Object.entries(o.env ?? {}).map(([k, v]) => `--setenv=${k}=${v}`);
  const r = await exec(
    systemdRun,
    [
      '--wait',
      '--pipe',
      '--collect',
      '--quiet',
      '--service-type=exec',
      `--property=RuntimeMaxSec=${String(Math.ceil(o.timeoutMs / 1000))}`,
      ...env,
      '--',
      ...argv,
    ],
    { timeoutMs: o.timeoutMs + 30_000 },
  );
  return r.stdout;
}

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

  async enable(unit: string, now: boolean): Promise<void> {
    await this.#exec(await this.#systemctl(), ['enable', ...(now ? ['--now'] : []), '--', this.#unitName(unit)], {
      timeoutMs: 120_000,
    });
  }

  async disable(unit: string, now: boolean): Promise<void> {
    await this.#exec(await this.#systemctl(), ['disable', ...(now ? ['--now'] : []), '--', this.#unitName(unit)], {
      timeoutMs: 120_000,
      // disabling a unit that isn't installed is not an error for our purposes
      okExitCodes: [0, 1, 5],
    });
  }

  async mask(unit: string): Promise<void> {
    await this.#exec(await this.#systemctl(), ['mask', '--', this.#unitName(unit)], { timeoutMs: 30_000 });
  }

  async unmask(unit: string): Promise<void> {
    await this.#exec(await this.#systemctl(), ['unmask', '--', this.#unitName(unit)], { timeoutMs: 30_000 });
  }

  async startAndWait(unit: string, timeoutMs: number): Promise<void> {
    // without --no-block systemctl waits for the start job to finish and fails if the unit fails
    await this.#exec(await this.#systemctl(), ['start', '--', this.#unitName(unit)], { timeoutMs });
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
