# ADR-0010: Node.js 24 LTS, strict TypeScript, ESM, bundled runtime

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
The spec chooses Node.js 24 LTS. Distros ship very different Node versions: some none, some old, Alpine
musl-only. A platform that runs on DCs can't depend on whichever Node the distro has.

## Decision
1. Node.js 24 LTS. TypeScript `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
   `verbatimModuleSyntax`. ESM only. The backend is compiled with `tsc` (project references); there's no
   bundler for the backend.
2. **Packages bundle the official Node.js binary** for x86_64 and arm64 (glibc) under `/usr/lib/opendc/node`,
   pinned and checksum-verified at build time. Distro Node is never used. Alpine (agent only, Tier 2) uses the
   musl build from Alpine's own package, or the unofficial-builds musl binary; to be decided in Phase 6.
3. Built-ins first: `node:test`, `node:crypto`, global `fetch`, `node:sqlite` (behind `PlatformDb`; it's still
   marked experimental/RC on Node 24, see ADR-0013), `node:util.parseArgs` for the CLI.
4. **Runtime timeline:** Node 24 moves to maintenance LTS in October 2026 and reaches end of life in April 2028.
   The 1.0 LTS release must ship on a Node line that covers our published support window, so the plan is to
   **re-evaluate at the start of Phase 7 and move to the next even-numbered LTS line if needed** (OPEN-QUESTIONS
   Q9). Code avoids APIs that are deprecated in later lines.

## Consequences
- About 40-50 MB more package size; behaviour is the same on every distro.
- We own Node security updates: a Node security release means a OpenDC patch release (covered by the release
  policy, Phase 7).
