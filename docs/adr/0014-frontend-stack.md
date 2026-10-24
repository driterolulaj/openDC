# ADR-0014: Frontend — React 19, Vite, Mantine, TanStack Query, React Router, i18next

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Decision
1. One React 19 SPA (`packages/web`), built with Vite, with three entry areas: `/console` (admin), `/portal`
   and `/self-service`. They share one design system and auth, and each area is code-split.
2. **Mantine** is the only UI kit (core, hooks, notifications, dates, form). It provides light and dark themes
   and accessible primitives. White-labeling (Phase 7) works at runtime through Mantine theme overrides loaded
   from the directory, with no rebuild.
3. **TanStack Query** for server state: every list is a server-paginated query with URL-synced
   filters. **React Router** (data router) with lazy routes generated from module manifests.
4. **i18next + react-i18next.** Namespaces per module, en and de at launch. A CI check fails on missing keys
   and on hard-coded user-visible strings (an ESLint rule).
5. Accessibility target: WCAG 2.1 AA. Playwright tests run axe-core checks, which needs approval as a dev
   dependency (see DEPENDENCIES).
6. API types come from `packages/shared` (Zod-inferred), and the fetch client is hand-written (~150 lines).

## Consequences
- `react-i18next`, the Mantine sub-packages and `postcss-preset-mantine` are needed in practice, even though
  the spec only names the parent libraries. They're listed in DEPENDENCIES as **pending approval**.
