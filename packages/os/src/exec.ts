// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The only place (besides the agent) that starts processes: execFile with an argv array, shell disabled,
 * a fixed environment, a timeout and an output cap (ADR-0006 §5, SECURITY.md §7).
 */
import { execFile } from 'node:child_process';
import { PlatformError } from '@opendc/shared';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBytes?: number;
  stdin?: string;
  /** Exit codes that count as success (default [0]). */
  okExitCodes?: number[];
  cwd?: string;
  /** Extra variables on top of the fixed environment (e.g. PASSWD for Samba tools, never argv). */
  env?: Record<string, string>;
}

export const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export type Exec = (binary: string, argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Runs `binary` (absolute path) with `argv`. Rejects with os.command-failed on a non-OK exit. */
export const exec: Exec = (binary, argv, opts = {}) => {
  if (!binary.startsWith('/'))
    return Promise.reject(new TypeError(`exec needs an absolute binary path, got ${binary}`));
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      binary,
      [...argv],
      {
        shell: false,
        env: { ...opts.env, PATH: SAFE_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBytes ?? 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const ok = (opts.okExitCodes ?? [0]).includes(code);
        if (ok) {
          resolvePromise({ stdout, stderr, exitCode: code });
          return;
        }
        const killed = err && 'killed' in err && err.killed;
        reject(
          new PlatformError(
            'os.command-failed',
            {
              binary,
              exitCode: killed ? 'timeout' : String(code),
              // the cause is usually at the end (tools log progress first)
              stderr: (stderr || (err?.message ?? '')).trim().slice(-600),
            },
            { cause: err },
          ),
        );
      },
    );
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
};
