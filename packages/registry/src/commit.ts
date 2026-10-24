// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Registry operations that touch the system, all through the agent (ADR-0005 §4-7):
 * set/unset a layer value, commit (render -> write changed files -> handlers -> rollback on failure),
 * and drift detection against the last rendered hashes.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, isPlatformError } from '@opendc/shared';
import type { NodeRole, RoleSelector, TemplateContext, TemplateFunction } from '@opendc/shared/manifest';
import { roleMatches } from '@opendc/shared/manifest';
import { JSON_HEADER_FIELD, withHeader, type CommentStyle } from './header.ts';
import { Registry, readsKey, type LayerValues, type WritableLayer } from './registry.ts';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface TemplateEntry {
  module: string;
  fileId: string;
  render: TemplateFunction;
  reads: string[];
  onChange: ({ kind: 'service'; action: 'reload' | 'restart' | 'try-reload-or-restart'; unit: string } | { kind: 'agent-op' | 'validate'; op: string })[];
  roles: RoleSelector[];
  comment: CommentStyle;
}

/** The agent calls the registry needs. Implemented with AgentClient in production and fakes in tests. */
export interface RegistryAgent {
  read(fileId: string): Promise<{ content: string | null; sha256: string | null }>;
  write(fileId: string, content: string, expectedPrevSha256: string | null): Promise<{ changed: boolean; sha256: string }>;
  restore(fileId: string): Promise<void>;
  service(action: 'reload' | 'restart', unit: string): Promise<void>;
  lock(holder: string): Promise<{ acquired: boolean; token?: string | undefined; heldBy?: string | undefined; since?: string | undefined }>;
  unlock(token: string): Promise<void>;
}

export const LAYER_FILES: Record<WritableLayer, string> = { local: 'core.registry-local', forced: 'core.registry-forced' };
export const RENDERED_FILE = 'core.registry-rendered';

const layerFileSchema = z.object({ schemaVersion: z.literal(1), values: z.record(z.string(), z.unknown()) });
const renderedSchema = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), z.object({ sha256: z.string(), renderedAt: z.string() })) });
type Rendered = z.infer<typeof renderedSchema>;

export const LOCK_STALE_SEC = 120;

export interface RegistryOptions {
  agent: RegistryAgent;
  keys: Registry;
  templates: readonly TemplateEntry[];
  node: TemplateContext['node'];
  holder: string;
}

export interface CommitReport {
  rendered: string[];
  changed: string[];
  handlers: string[];
}

/** Parses a layer file (local.json / forced.json); exported for read-only consumers like the API. */
export function parseLayer(fileId: string, content: string | null): Record<string, unknown> {
  if (content === null || content.trim() === '') return {};
  try {
    const { [JSON_HEADER_FIELD]: _h, ...rest } = JSON.parse(content) as Record<string, unknown>;
    return layerFileSchema.parse(rest).values;
  } catch (e) {
    throw new PlatformError('registry.layer-corrupt', { layer: fileId, path: fileId, reason: e instanceof Error ? e.message : String(e) }, { cause: e });
  }
}

export class RegistryService {
  readonly #o: RegistryOptions;

  constructor(o: RegistryOptions) {
    this.#o = o;
  }

  /** Reads the writable layers through the agent and returns a registry with them applied. */
  async load(policy: LayerValues['domain-policy'] = {}): Promise<Registry> {
    const [local, forced] = await Promise.all([this.#o.agent.read(LAYER_FILES.local), this.#o.agent.read(LAYER_FILES.forced)]);
    return this.#o.keys
      .withLayer('domain-policy', policy)
      .withLayer('local', parseLayer(LAYER_FILES.local, local.content))
      .withLayer('forced', parseLayer(LAYER_FILES.forced, forced.content));
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const l = await this.#o.agent.lock(this.#o.holder);
    if (!l.acquired || !l.token) {
      throw new PlatformError('registry.locked', { holder: l.heldBy ?? '?', since: l.since ?? '?', staleSec: LOCK_STALE_SEC });
    }
    try {
      return await fn();
    } finally {
      await this.#o.agent.unlock(l.token);
    }
  }

  /** Sets (value !== undefined) or unsets a key in a writable layer, then commits affected templates. */
  async set(key: string, value: unknown, layer: WritableLayer = 'local'): Promise<CommitReport> {
    return this.#withLock(async () => {
      const before = await this.load();
      const fileId = LAYER_FILES[layer];
      const current = await this.#o.agent.read(fileId);
      const values = parseLayer(fileId, current.content);
      if (value === undefined) {
        before.definition(key);
        delete values[key];
      } else {
        values[key] = before.validate(key, value);
      }
      const content = withHeader('json-field', 'core', fileId, JSON.stringify({ schemaVersion: 1, values: sortObject(values) }));
      await this.#o.agent.write(fileId, content, current.sha256);
      const after = before.withLayer(layer, values);
      return this.#commit(after, after.diff(before));
    });
  }

  /** Re-renders templates: those reading `changedKeys`, or all templates for this role when omitted. */
  async commit(changedKeys?: readonly string[]): Promise<CommitReport> {
    return this.#withLock(async () => this.#commit(await this.load(), changedKeys));
  }

  async #commit(reg: Registry, changedKeys?: readonly string[]): Promise<CommitReport> {
    const role: NodeRole = this.#o.node.role;
    const affected = this.#o.templates.filter(
      (t) => roleMatches(role, t.roles) && (!changedKeys || changedKeys.some((k) => readsKey(t.reads, k))),
    );
    const report: CommitReport = { rendered: [], changed: [], handlers: [] };
    const written: string[] = [];
    let step = 'render';
    try {
      const outputs = affected.map((t) => {
        step = `render ${t.fileId}`;
        const body = t.render(reg.view(t.reads, t.fileId), { node: this.#o.node });
        return { t, content: withHeader(t.comment, t.module, t.fileId, body) };
      });
      const rendered = await this.#readRendered();
      for (const { t, content } of outputs) {
        step = `write ${t.fileId}`;
        report.rendered.push(t.fileId);
        const cur = await this.#o.agent.read(t.fileId);
        rendered.files[t.fileId] = { sha256: sha256(content), renderedAt: new Date().toISOString() };
        if (cur.sha256 === sha256(content)) continue;
        await this.#o.agent.write(t.fileId, content, cur.sha256);
        written.push(t.fileId);
        report.changed.push(t.fileId);
      }
      // handlers in a stable order, each unit once
      const done = new Set<string>();
      for (const { t } of outputs.filter((o) => report.changed.includes(o.t.fileId))) {
        for (const h of t.onChange) {
          if (h.kind !== 'service') continue; // agent-op/validate handlers arrive with the modules that need them (Phase 3)
          const action = h.action === 'try-reload-or-restart' ? 'reload' : h.action;
          const id = `${action} ${h.unit}`;
          if (done.has(id)) continue;
          step = id;
          await this.#o.agent.service(action, h.unit);
          done.add(id);
          report.handlers.push(id);
        }
      }
      if (outputs.length) {
        step = 'record rendered hashes';
        const cur = await this.#o.agent.read(RENDERED_FILE);
        await this.#o.agent.write(RENDERED_FILE, withHeader('json-field', 'core', RENDERED_FILE, JSON.stringify(rendered)), cur.sha256);
      }
      return report;
    } catch (e) {
      for (const f of written.reverse()) await this.#o.agent.restore(f).catch(() => undefined);
      if (isPlatformError(e) && e.code === 'registry.invalid-value') throw e;
      throw new PlatformError('registry.commit-failed', { step, reason: e instanceof Error ? e.message : String(e) }, { cause: e });
    }
  }

  async #readRendered(): Promise<Rendered> {
    const cur = await this.#o.agent.read(RENDERED_FILE);
    if (!cur.content) return { schemaVersion: 1, files: {} };
    try {
      const { [JSON_HEADER_FIELD]: _h, ...rest } = JSON.parse(cur.content) as Record<string, unknown>;
      return renderedSchema.parse(rest);
    } catch {
      return { schemaVersion: 1, files: {} };
    }
  }

  /** Managed files whose content no longer matches what the registry last rendered (manual edits). */
  async drift(): Promise<{ fileId: string; state: 'modified' | 'missing' | 'never-rendered' }[]> {
    const rendered = await this.#readRendered();
    const out: { fileId: string; state: 'modified' | 'missing' | 'never-rendered' }[] = [];
    for (const t of this.#o.templates.filter((x) => roleMatches(this.#o.node.role, x.roles))) {
      const want = rendered.files[t.fileId];
      const cur = await this.#o.agent.read(t.fileId);
      if (!want) out.push({ fileId: t.fileId, state: 'never-rendered' });
      else if (cur.sha256 === null) out.push({ fileId: t.fileId, state: 'missing' });
      else if (cur.sha256 !== want.sha256) out.push({ fileId: t.fileId, state: 'modified' });
    }
    return out;
  }
}

function sortObject(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
