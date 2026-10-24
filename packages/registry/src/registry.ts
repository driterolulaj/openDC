// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed, layered key/value store (ADR-0005). Precedence: default < domain-policy < local < forced.
 * Keys are declared by module manifests; values are validated with the key's Zod schema on every write
 * and again on every read from a layer (a hand-edited layer can't inject an invalid value).
 */
import { PlatformError } from '@opendc/shared';
import type { RegistryKeyDefinition, RegistryView } from '@opendc/shared/manifest';

export const layers = ['default', 'domain-policy', 'local', 'forced'] as const;
export type Layer = (typeof layers)[number];
export type WritableLayer = 'local' | 'forced';
export type LayerValues = Partial<Record<Exclude<Layer, 'default'>, Record<string, unknown>>>;

export interface Explanation {
  key: string;
  value: unknown;
  layer: Layer;
  /** Every layer that defines the key, lowest precedence first. */
  defined: { layer: Layer; value: unknown; valid: boolean }[];
}

export interface InvalidLayerValue {
  key: string;
  layer: Layer;
  issues: string;
}

const issuesOf = (e: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  e.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

export class Registry {
  readonly #keys: ReadonlyMap<string, RegistryKeyDefinition>;
  readonly #layers: LayerValues;

  constructor(keys: readonly RegistryKeyDefinition[], layerValues: LayerValues = {}) {
    this.#keys = new Map(keys.map((k) => [k.name, k]));
    this.#layers = layerValues;
  }

  /** A copy with one layer replaced (used to compute the effect of a set/unset before writing it). */
  withLayer(layer: Exclude<Layer, 'default'>, values: Record<string, unknown>): Registry {
    return new Registry([...this.#keys.values()], { ...this.#layers, [layer]: values });
  }

  layer(layer: Exclude<Layer, 'default'>): Record<string, unknown> {
    return { ...(this.#layers[layer] ?? {}) };
  }

  definition(key: string): RegistryKeyDefinition {
    const def = this.#keys.get(key);
    if (!def) throw new PlatformError('registry.unknown-key', { key });
    return def;
  }

  keys(): string[] {
    return [...this.#keys.keys()].sort();
  }

  /** Validates (and normalises) a value for `key`; throws registry.invalid-value. */
  validate(key: string, value: unknown): unknown {
    const r = this.definition(key).schema.safeParse(value);
    if (!r.success) throw new PlatformError('registry.invalid-value', { key, issues: issuesOf(r.error) });
    return r.data;
  }

  explain(key: string): Explanation {
    const def = this.definition(key);
    const defined: Explanation['defined'] = [{ layer: 'default', value: def.default, valid: true }];
    for (const layer of ['domain-policy', 'local', 'forced'] as const) {
      const values = this.#layers[layer];
      if (values && Object.hasOwn(values, key)) {
        const ok = def.schema.safeParse(values[key]);
        // A domain policy may only set keys that allow it.
        const allowed = layer !== 'domain-policy' || def.policySettable;
        defined.push({ layer, value: ok.success ? ok.data : values[key], valid: ok.success && allowed });
      }
    }
    const winner = [...defined].reverse().find((d) => d.valid) ?? { layer: 'default' as const, value: def.default };
    return { key, value: winner.value, layer: winner.layer, defined };
  }

  get<T = unknown>(key: string): T {
    return this.explain(key).value as T;
  }

  /** Values in layers that are ignored because they are invalid (shown by `registry list` and diagnostics). */
  invalidValues(): InvalidLayerValue[] {
    const out: InvalidLayerValue[] = [];
    for (const layer of ['domain-policy', 'local', 'forced'] as const) {
      for (const [key, value] of Object.entries(this.#layers[layer] ?? {})) {
        const def = this.#keys.get(key);
        if (!def) {
          out.push({ key, layer, issues: 'unknown key' });
          continue;
        }
        const r = def.schema.safeParse(value);
        if (!r.success) out.push({ key, layer, issues: issuesOf(r.error) });
        else if (layer === 'domain-policy' && !def.policySettable)
          out.push({ key, layer, issues: 'not settable by a domain policy' });
      }
    }
    return out;
  }

  /** A view that only allows reading the keys a template declared (exact names or "prefix.*"). */
  view(reads: readonly string[], fileId: string): RegistryView {
    const allowed = (key: string): boolean =>
      reads.some((r) => (r.endsWith('.*') ? key.startsWith(r.slice(0, -1)) : key === r));
    return {
      get: <T>(key: string): T => {
        if (!allowed(key)) throw new TypeError(`Template ${fileId} reads ${key} without declaring it in "reads"`);
        return this.get<T>(key);
      },
    };
  }

  /** Keys whose effective value differs between this registry and `other`. */
  diff(other: Registry): string[] {
    return this.keys().filter((k) => JSON.stringify(this.get(k)) !== JSON.stringify(other.get(k)));
  }
}

/** Does a template that reads `reads` depend on `key`? */
export function readsKey(reads: readonly string[], key: string): boolean {
  return reads.some((r) => (r.endsWith('.*') ? key.startsWith(r.slice(0, -1)) : key === r));
}
