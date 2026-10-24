# Architecture decision records

Format: Context, Decision, Consequences, Alternatives considered. ADRs 0001–0020 and 0022 were accepted at the Phase 0 review on
2026-10-24; 0021 waits for OPEN-QUESTIONS Q7. **Changing an Accepted ADR requires the user's approval**; to replace one, write a new ADR
that supersedes it.

| # | Title | Spec ref | Status |
|---|---|---|---|
| [0001](0001-record-decisions.md) | Record architecture decisions | §2 | Accepted |
| [0002](0002-samba-ad-only-directory.md) | Samba AD is the only directory technology | §2.1 | Accepted |
| [0003](0003-platform-objects-in-directory.md) | Platform objects live in the directory, no schema extension for the MVP | §2.2 | Accepted |
| [0004](0004-change-propagation-watcher.md) | Change propagation with a per-node DirSync/USN watcher | §2.3 | Accepted |
| [0005](0005-config-registry.md) | Config Registry | §2.4 | Accepted |
| [0006](0006-privilege-separation-agent.md) | Privilege separation with a typed root agent | §2.5 | Accepted |
| [0007](0007-mtls-and-internal-pki.md) | Node mTLS and a two-tier internal CA | §2.6, §6.7 | Accepted |
| [0008](0008-os-abstraction-layer.md) | OS abstraction layer | §2.7 | Accepted |
| [0009](0009-samba-deployment-modes.md) | Samba deployment modes: native and container | §2.8 | Accepted |
| [0010](0010-runtime-node-typescript.md) | Node.js 24 LTS, strict TypeScript, ESM, bundled runtime | §4 | Accepted |
| [0011](0011-http-validation-openapi.md) | Fastify + Zod, OpenAPI generated from Zod with no extra dependencies | §4 | Accepted |
| [0012](0012-ldap-client-and-bind-model.md) | `ldapts` and the directory bind model (delegated service account, tier-0 via agent) | §4, §6.10 | Accepted |
| [0013](0013-platform-db-and-audit-replication.md) | Node-local SQLite platform DB; audit log replicated between DCs | §4, §6.10 | Accepted |
| [0014](0014-frontend-stack.md) | Frontend: React 19, Vite, Mantine, TanStack Query, React Router, i18next | §4 | Accepted |
| [0015](0015-testing-and-vm-lab.md) | Testing strategy and VM lab | §8 | Accepted |
| [0016](0016-packaging.md) | Packaging with nfpm and systemd | §3 | Accepted |
| [0017](0017-leader-is-pdc-emulator.md) | Domain-wide singleton jobs run on the PDC emulator | §2.1 | Accepted |
| [0018](0018-posix-id-mapping.md) | POSIX IDs from the RID (RFC2307 attributes) | §6.2, §6.6 | Accepted |
| [0019](0019-sysvol-replication.md) | SYSVOL replication from the PDC emulator | not in spec (gap) | Accepted |
| [0020](0020-console-authentication.md) | Console login via LDAPS bind against a verified DC | §6.9 | Accepted |
| [0021](0021-front-proxy-and-acme.md) | Front proxy (nginx) and ACME client (lego) | §6.7, §6.8 | Proposed (needs decision) |
| [0022](0022-module-system.md) | Declarative module manifests with build-time code generation | §5 | Accepted |
| [0023](0023-license-agpl.md) | License: AGPL-3.0 | Q12 | Accepted |
