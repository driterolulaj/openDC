// SPDX-License-Identifier: AGPL-3.0-only
/** Shapes of the generated module tables (written by `npm run gen`; this file is hand-written). */
import type { RoleSelector, TemplateFunction } from '@opendc/shared/manifest';

export type CommentStyle = 'hash' | 'semicolon' | 'slash' | 'xml' | 'json-field' | 'none';

export type TemplateHandler =
  | { kind: 'service'; action: 'reload' | 'restart' | 'try-reload-or-restart'; unit: string }
  | { kind: 'agent-op' | 'validate'; op: string; args?: Record<string, unknown> };

export interface GeneratedTemplate {
  module: string;
  fileId: string;
  render: TemplateFunction;
  reads: string[];
  onChange: TemplateHandler[];
  roles: RoleSelector[];
  comment: CommentStyle;
}

/** A module's Fastify plugin; typed loosely here so the modules package doesn't depend on Fastify. */
export interface GeneratedApiModule {
  module: string;
  plugin: unknown;
  publicRoutes: { method: 'GET' | 'POST'; path: string; rateLimit: { max: number; windowSec: number } }[];
}

export interface GeneratedWatcher {
  module: string;
  id: string;
  handler: unknown;
  base: string;
  scope: 'base' | 'one' | 'sub';
  filter: string;
  attributes: string[];
  roles: RoleSelector[];
  timeoutMs?: number;
  debounceMs?: number;
}
