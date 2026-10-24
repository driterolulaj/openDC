// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Types that module registry entries implement (ADR-0005). Key definitions carry Zod schemas, so they live
 * in a module's `keysEntry` file rather than in the plain-data manifest. Templates are pure functions.
 */
import type { z } from 'zod';
import type { NodeRole } from './schema.ts';

export interface RegistryKeyDefinition<S extends z.ZodType = z.ZodType> {
  /** Dotted, prefixed with the owning module id. */
  name: string;
  schema: S;
  default: z.output<S>;
  /** i18n key "<ns>:<key>" */
  description: string;
  /** May a domain policy of type "registry" set this key? */
  policySettable: boolean;
  effect?: 'none' | 'reload' | 'restart' | 'reboot';
}

/** Typed read access to the merged registry, limited to the keys a template declared in `reads`. */
export interface RegistryView {
  get<T = unknown>(key: string): T;
}

export interface TemplateContext {
  /** Host facts a template may use; they come from the OS adapter, never from distro checks in templates. */
  node: { hostname: string; fqdn: string; role: NodeRole };
}

export type TemplateFunction = (view: RegistryView, ctx: TemplateContext) => string;
