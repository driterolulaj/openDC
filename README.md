# OpenDC

A self-hosted, distro-agnostic identity and infrastructure platform for Linux: an Active Directory-compatible
domain (Samba AD) with a web console, App Center, portal and multi-server management, for integrators
deploying at many client sites.

**Status: Phase 1 (foundation) complete 2026-10-24.** The platform skeleton installs as `.deb` packages and
runs hardened on Debian 13 and Ubuntu 24.04: root agent, API with LDAPS login and RBAC, audit log, Config
Registry, console login. Domain management (users, groups, provisioning) is Phase 2.

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then [ROADMAP.md](ROADMAP.md) and
[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md). The VM lab is described in
[test/env/proxmox/README.md](test/env/proxmox/README.md).

## Development

Node.js 24 LTS, npm workspaces.

```sh
npm ci --ignore-scripts
npm run build
npm run check      # lint, typecheck, generated files, OpenAPI, tests, coverage gate
npm run package    # .deb + tarball (on Linux)
```

| Package | What |
|---|---|
| `packages/shared` | Errors (en/de), LDAP escaping/filters/DNs/controls, manifest schema, agent protocol, PlatformDb, `npm run gen` |
| `packages/os` | OS adapter (Debian family), safe exec, managed file writes |
| `packages/agent` | `opendc-agent`: root, socket-activated, typed operations from the compiled allowlist |
| `packages/registry` | Config Registry: layers, templates, commit/rollback, drift |
| `packages/api` | `opendc-api`: Fastify, sessions, LDAPS login, RBAC, audit, jobs/SSE, OpenAPI |
| `packages/watcher` | `opendc-watcher`: renders managed files; DirSync following in Phase 3 |
| `packages/cli` | `opendc` CLI |
| `packages/web` | Console (React, Mantine) |
| `modules/` | Feature modules and their manifests (`core` so far) |
| `packaging/` | systemd units, nfpm build, tarball installer |

## License

OpenDC is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`); see
[ADR-0023](docs/adr/0023-license-agpl.md). Components OpenDC installs and configures (Samba, Kea, CUPS, ...)
keep their own licenses.
