# ADR-0015: Testing strategy and VM lab

Status: Proposed · Date: 2026-10-06 · Lab host needs the project owner's decision (OPEN-QUESTIONS Q11)

## Context
Samba AD needs xattrs, ACLs and real networking, so unprivileged containers aren't enough. The development
machine is currently Windows 11. Tests must never modify the host.

## Decision
1. **Unit tests** (`node:test`) for all pure logic. Must-have coverage: LDAP escaping, policy inheritance,
   registry layering, template rendering, agent allowlist/schema rejection, RBAC scope evaluation, ID
   mapping, profile validation, the audit hash chain.
2. **Lab definitions** under `test/env/`, using **Incus VMs** as the primary backend (scriptable, fast, cloud
   images for every Tier-1 distro, network ACLs and `tc` for simulated latency). A Vagrant + libvirt backend
   is a secondary option for contributors who already have it.
   - `small`: 1 DC + 1 Linux client
   - `standard`: 2 DCs + 1 member + 1 client
   - `multisite`: 2 sites joined by a bridge with `tc netem` latency (default 80 ms, 1% loss), 3 DCs (one of
     them an RODC), one member per site
   - Command: `npm run lab -- up <topology> [--distro debian-13]`, `lab down`, `lab snapshot`.
3. **Integration tests** run inside the lab against real Samba: provisioning, user CRUD, two-DC replication,
   Kea rendering, app install, Linux client join with realmd/sssd and login.
4. **E2E:** Playwright against the lab DC (setup wizard, user lifecycle, password reset, app install).
5. **Upgrade tests** (Phase 7): install N-1, deploy a profile, upgrade DCs one at a time, verify.
6. **CI:** lint, typecheck and unit tests on every push (hosted runners). VM tests run nightly on a
   self-hosted Linux runner with KVM, because hosted runners lack reliable nested virtualisation. **We need a
   Linux host with KVM for the lab** (Q11).
7. The Windows client join is a documented manual checklist (`test/manual/windows-join.md`) until a Windows
   VM image licence is sorted out.
