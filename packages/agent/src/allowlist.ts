// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The compiled allowlist (ADR-0006 §6): which operations each socket may call and which managed files and
 * units exist. It comes only from `src/generated/allowlist.ts`, which `npm run gen` writes from the module
 * manifests; nothing at runtime can extend it.
 */
import { PlatformError } from '@opendc/shared';
import { isImplementedOp, type ImplementedOp } from '@opendc/shared/agent';
import type { AgentSocket } from '@opendc/shared/manifest';
import { allowlist as generated } from './generated/allowlist.ts';

export interface ManagedFileEntry {
  module: string;
  pathKey: string;
  owner: 'root' | 'service';
  mode: number;
  comment: string;
}

export type UnitAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'status';

export interface AllowlistData {
  sockets: Record<AgentSocket, readonly string[]>;
  /** Setup operations: also callable on the api socket with a valid setup token. */
  setup: readonly string[];
  files: Record<string, ManagedFileEntry>;
  units: Record<string, readonly string[]>;
}

export class Allowlist {
  readonly #sockets: Record<AgentSocket, ReadonlySet<string>>;
  readonly #setup: ReadonlySet<string>;
  readonly #files: ReadonlyMap<string, ManagedFileEntry>;
  readonly #units: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(data: AllowlistData) {
    this.#sockets = {
      api: new Set(data.sockets.api),
      watch: new Set(data.sockets.watch),
      cli: new Set(data.sockets.cli),
    };
    this.#setup = new Set(data.setup);
    this.#files = new Map(Object.entries(data.files));
    this.#units = new Map(Object.entries(data.units).map(([u, a]) => [u, new Set(a)]));
    // The agent refuses to start if the allowlist names an operation it doesn't implement.
    const missing = [...this.#sockets.api, ...this.#sockets.watch, ...this.#sockets.cli, ...this.#setup].filter(
      (op) => !isImplementedOp(op),
    );
    if (missing.length) {
      throw new PlatformError('agent.unknown-op', { op: [...new Set(missing)].join(', '), version: 1 });
    }
  }

  /**
   * The op if `socket` may call it; otherwise throws agent.op-not-allowed. Setup operations are also allowed
   * on the api socket when the request carried a valid setup token.
   */
  op(socket: AgentSocket, op: string, setupTokenValid = false): ImplementedOp {
    const viaSetup = socket === 'api' && setupTokenValid && this.#setup.has(op);
    if ((!this.#sockets[socket].has(op) && !viaSetup) || !isImplementedOp(op))
      throw new PlatformError('agent.op-not-allowed', { op, socket });
    return op;
  }

  isSetupOp(op: string): boolean {
    return this.#setup.has(op);
  }

  file(fileId: string, socket: AgentSocket, op: string): ManagedFileEntry {
    const f = this.#files.get(fileId);
    if (!f) throw new PlatformError('agent.op-not-allowed', { op: `${op}(${fileId})`, socket });
    return f;
  }

  unit(unit: string, action: UnitAction, socket: AgentSocket, op: string): void {
    if (!this.#units.get(unit)?.has(action))
      throw new PlatformError('agent.op-not-allowed', { op: `${op}(${unit})`, socket });
  }

  files(): ReadonlyMap<string, ManagedFileEntry> {
    return this.#files;
  }
}

export function loadAllowlist(): Allowlist {
  return new Allowlist(generated);
}
