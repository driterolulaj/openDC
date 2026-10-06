# Phase 0 design artefacts

| File | What | Moves to (Phase 1) |
|---|---|---|
| `module-manifest.ts` | `ModuleManifest` interface and supporting types (ADR-0022) | `packages/shared/src/manifest/` |
| `os-adapter.ts` | `OsFacts` / `OsActions` interfaces (ADR-0008) | `packages/os/src/types.ts` |
| `agent-operations.md` | Agent operation catalogue, protocol and per-socket allowlists (ADR-0006) | `packages/agent/src/ops/*` (one file per op) |
| `directory-object-model.md` | Containers, classes, attributes, payload schemas, the reserved schema extension (ADR-0003) | `packages/shared/src/directory/` |

The `.ts` files are types only. They're written to compile under `strict` once `packages/shared` exists, and
in Phase 0 they're reviewed as documents. Shared primitive types (`SemVer`, `I18nKey`, ...) are declared at the
top of each file so the files stand alone.
