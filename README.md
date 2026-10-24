# OpenDC

A self-hosted, distro-agnostic identity and infrastructure platform for Linux: an Active Directory-compatible
domain (Samba AD) with a web console, App Center, portal and multi-server management, for integrators
deploying at many client sites.

**Status: Phase 0 (design) reviewed 2026-10-24.** No feature code yet; Phase 1 (foundation) is next.

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then [ROADMAP.md](ROADMAP.md) and
[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md). The VM lab is described in
[test/env/proxmox/README.md](test/env/proxmox/README.md).

## License

OpenDC is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`); see
[ADR-0023](docs/adr/0023-license-agpl.md). Components OpenDC installs and configures (Samba, Kea, CUPS, ...)
keep their own licenses.
