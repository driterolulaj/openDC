# ADR-0008: OS abstraction layer

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
Package managers, service names, file paths, firewalls, MAC systems, Samba/Kerberos builds, resolver setup
(systemd-resolved vs plain resolv.conf) and network configuration (netplan, NetworkManager, ifupdown,
wicked) all differ between distros. If distro checks spread through the code, every new distro means editing
the whole codebase.

## Decision
1. `packages/os` defines the interfaces (`docs/design/os-adapter.ts`) and one adapter per family: `debian`
   (Debian, Ubuntu), `rhel` (RHEL, Rocky, Alma, Fedora), `suse`, `arch`, `alpine`.
2. Adapter selection reads `/etc/os-release` (`ID`, `ID_LIKE`, `VERSION_ID`) once at startup and matches it
   against a support matrix that maps (distro, version, role) to (adapter, tier, Samba mode). Unknown
   combinations are **refused with a clear message**. An `--unsupported` override exists for labs and marks
   the node as unsupported in diagnostics.
3. The interface is split in two:
   - `OsFacts`: read-only and side-effect free. Paths, unit names, binary locations, capabilities, version
     detection. Usable from the API for planning and pre-flight checks.
   - `OsActions`: state-changing. **Only instantiated inside `opendc-agent`.**
4. **No distro conditionals outside `packages/os`.** An ESLint rule bans importing `/etc/os-release` parsing
   and adapter internals elsewhere.
5. Each adapter has a conformance test suite: the same tests run against every adapter, unit-level with
   mocked exec, plus VM-level in nightly CI for Tier 1.

## Consequences
- Adding a distro means writing an adapter and adding a matrix row.
- The interfaces must be designed broadly up front. Network configuration is the hardest part, so it's
  deliberately minimal: read state, plus apply with automatic rollback.
