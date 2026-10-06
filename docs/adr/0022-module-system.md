# ADR-0022: Declarative module manifests with build-time code generation

Status: Proposed · Date: 2026-10-06

## Context
A module contributes API routes, UI routes, registry keys and templates, watcher handlers, agent operations,
diagnostics and i18n. If the manifest imported all of these directly, then the web bundle, the agent and the
API would all import each other's code, and the agent's allowlist could be influenced at runtime.

## Decision
1. `modules/<id>/manifest.ts` default-exports a **plain data object** that satisfies `ModuleManifest`
   (`docs/design/module-manifest.ts`). It references code only by module-relative entry paths
   (`{ entry: './api/index.ts' }`).
2. `npm run gen` (a script in `packages/shared/tools`) validates every manifest with Zod and generates:
   - `packages/api/src/generated/modules.ts`: route plugin imports, permissions
   - `packages/web/src/generated/routes.tsx`: `React.lazy` imports per UI route
   - `packages/watcher/src/generated/handlers.ts`
   - `packages/registry/src/generated/{keys,templates}.ts`
   - `packages/agent/src/generated/allowlist.ts`: per-socket op sets and managed fileIds/units/package sets
   - `packages/shared/src/generated/permissions.ts`, plus the i18n namespace index

   Generated files are committed, and CI checks that they're up to date.
3. Validation rules: unique ids, permissions prefixed with the module id, registry keys prefixed with the
   module id, referenced agent operations must exist in the catalogue, handlers may only watch bases inside
   the module's declared directory scope (or standard AD classes it declares read access to), and every
   declared i18n key exists in en and de.
4. **No runtime module federation and no runtime plugin loading.** Third-party extensions ship as App Center
   apps.
5. Modules can be **enabled or disabled** per installation (stored in the directory). Disabled modules keep
   their code but register no routes, handlers or UI.

## Consequences
- The agent is built only from manifest data plus its own operation implementations, so there are no
  cross-imports.
- Adding a module means a manifest, its code and `npm run gen`.
