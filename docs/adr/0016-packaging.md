# ADR-0016: Packaging with nfpm and systemd

Status: Proposed · Date: 2026-10-06

## Decision
1. `nfpm` (a single static binary, used at build time only) produces `.deb` and `.rpm` for x86_64 and arm64.
   There's also a tarball with `install.sh` (POSIX sh, shellcheck-clean) as a fallback.
2. Packages:

   | Package | Contents |
   |---|---|
   | `myucs-common` | Node runtime, shared code, agent, watcher, CLI, OS adapters |
   | `myucs-dc` | DC role modules, depends on the distro Samba DC packages in native mode |
   | `myucs-member` | Member-server modules |
   | `myucs-web` | Console static assets |

   Distro-specific dependency names come from per-distro nfpm overrides generated from the OS adapter's
   package map.
3. Maintainer scripts only create system users and directories and run `systemctl daemon-reload`. **They never
   provision or join anything**; that only happens through the setup wizard or `myucs deploy`.
4. systemd units are hardened (SECURITY.md §6). The agent is socket-activated.
5. Release packages and repository metadata are signed (GPG for apt/rpm repos). The App Center catalog is
   signed separately with Ed25519.
6. A CycloneDX SBOM is generated per release from the lockfile (a dev-time tool, pending approval).
