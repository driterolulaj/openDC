# CLAUDE.md — conventions for OpenDC sessions

> **OpenDC** is the product name (OPEN-QUESTIONS Q1, decided 2026-10-24; the working name was "MyUCS").
> The lowercase id `opendc` is used for binaries, users, paths and the directory container
> `CN=OpenDC,CN=System`. Licensed AGPL-3.0-only (ADR-0023).

## What this project is
A self-hosted, distro-agnostic identity and infrastructure platform (UCS-class). A Node.js/TypeScript backend
and a React console **orchestrate** proven components (Samba AD, Kerberos, Samba DNS/BIND9_DLZ, Kea, CUPS,
OCI containers). We never reimplement LDAP, a KDC, DNS, DHCP, SMB or an IdP.

It is a general-purpose product installed by integrators at many client sites. **Never hard-code anything
site-specific.** Topology, names, subnets and features are configurable; ship defaults, allow overrides.

## Current phase
See `ROADMAP.md`. **Phase 0 (design) was reviewed on 2026-10-24** and all blocking questions are answered. Phase 1
(foundation) starts only after the user's explicit go-ahead.

## Where things are
- `docs/ARCHITECTURE.md` — components, data flow, diagrams. Start here.
- `docs/adr/` — architecture decision records. **Changing an ADR requires the user's approval.**
- `docs/design/` — Phase 0 interfaces (`module-manifest.ts`, `os-adapter.ts`), the agent operation catalogue
  and the directory object model. In Phase 1 the `.ts` files move into `packages/shared` and `packages/os`.
- `docs/DEPENDENCIES.md` — every third-party dependency and why. `docs/SECURITY.md` — threat model.

## Hard rules (from the spec — do not relax)
1. **Ask before:** adding a dependency not in DEPENDENCIES.md (approved column), proposing/applying any AD
   schema extension, changing an ADR, running anything outside this folder or the test VMs.
2. **Never modify the host machine.** Samba/provisioning/join tests run only in disposable VMs (`test/env/`).
3. **No shell strings.** `execFile`/`spawn` with argument arrays only, `shell: false`. Lint rule enforces it.
4. **No distro checks outside `packages/os`.** Everything distro-specific goes through the OS adapter.
5. **Root actions only via `opendc-agent`** typed operations (see `docs/design/agent-operations.md`). The
   allowlist is compiled at build time; it is never extended at runtime.
6. **Zod at every boundary** (HTTP, agent RPC, node RPC, directory payloads, files, profiles).
7. **LDAP filters/DNs only via the escaping helpers** in `packages/shared/src/ldap/`. Never concatenate.
8. **No plaintext secrets** in the platform DB, logs, API responses, job output or audit diffs.
9. **Nothing assumes one DC, one site or one subnet.**
10. Every user-facing string goes through i18next (en + de).
11. If the spec is wrong or impractical (e.g. a Samba limitation), say so and propose an alternative.

## Code conventions (apply from Phase 1)
- TypeScript strict, ESM only, Node 24 LTS APIs. `tsc` for the backend, Vite for the web app. No Babel.
- Prefer Node built-ins: `node:test`, `node:crypto`, `fetch`, `node:sqlite` (behind `PlatformDb`).
- Under ~100 lines? Write it, don't add a dependency.
- Exact version pins; lockfile committed; `npm ci --ignore-scripts` in CI.
- Errors: throw `PlatformError` with a code from `packages/shared/src/errors.ts`. Messages name the
  cause **and** the fix ("Time skew 7m exceeds Kerberos 5m limit; check chrony on dc2").
- Directory payloads carry `schemaVersion`; readers ignore unknown fields and never rewrite an object whose
  `schemaVersion` is newer than they understand (needed for rolling upgrades).
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`. Dependencies must carry an
  AGPL-compatible license (ADR-0023).
- Every managed file starts with the generated-file header from the Config Registry.
- Tests: unit tests next to the code (`*.test.ts`, `node:test`); web uses Vitest; E2E Playwright in `test/e2e`.
- Commit at each green milestone; messages say what and why.

## Workflow
- Plan, then build small vertical slices (API + UI + tests together).
- Keep `ROADMAP.md` checkboxes current.
- At the end of each phase: summarize what was built, what was tested and the known gaps, then **stop and
  wait for the user's go-ahead.**

## Dev environment notes
- The repo lives in a local, non-synced folder on the owner's Windows machine, never in OneDrive (Q11).
- The VM lab is a 2-node Proxmox VE cluster driven by `test/env/proxmox/pve-lab.sh` (ADR-0015). Its gateway node
  carries the lab network files listed in `test/env/proxmox/README.md`. The lab tooling may change those files,
  lab-tagged VMs and the lab SDN objects, and nothing else on the cluster.
- Line endings are LF (`.gitattributes`). Agent/systemd/Samba code only runs on Linux; pure logic tests
  must also pass on Windows/macOS dev machines.
