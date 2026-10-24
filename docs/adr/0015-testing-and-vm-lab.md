# ADR-0015: Testing strategy and VM lab

Status: Accepted 2026-10-24 · Date: 2026-10-06 · Amended 2026-10-24: Proxmox VE is the primary lab backend (approved by
the project owner, answers the lab half of OPEN-QUESTIONS Q11)

## Context
Samba AD needs xattrs, ACLs and real networking, so unprivileged containers aren't enough. The development
machine is currently Windows 11. Tests must never modify the host.

## Decision
1. **Unit tests** (`node:test`) for all pure logic. Must-have coverage: LDAP escaping, policy inheritance,
   registry layering, template rendering, agent allowlist/schema rejection, RBAC scope evaluation, ID
   mapping, profile validation, the audit hash chain.
2. **Lab definitions** under `test/env/`. Topologies are backend-neutral tables (`test/env/proxmox/topologies/`
   today, moved to `test/env/topologies/` once a second backend exists).
   - **Primary backend: Proxmox VE** (`test/env/proxmox/`, amended 2026-10-24), on the project's lab cluster.
     It uses an isolated SDN VXLAN network across all nodes with a NAT gateway that blocks private destinations,
     verified cloud-image templates per node, tagged linked clones and snapshots. Placing VMs on different nodes
     exercises real cross-host replication.
   - **Secondary backend: Incus VMs**, for contributors with a local Linux/KVM host (scriptable, fast, cloud
     images for every Tier-1 distro, network ACLs and `tc` for simulated latency). A Vagrant + libvirt backend
     remains an option for contributors who already have it.
   - `small`: 1 DC + 1 Linux client
   - `standard`: 2 DCs + 1 member + 1 client
   - `multisite`: 2 sites joined by a bridge with `tc netem` latency (default 80 ms, 1% loss), 3 DCs (one of
     them an RODC), one member per site
   - Command: `npm run lab -- up <topology> [--distro debian-13]`, `lab down`, `lab snapshot`. Until the npm
     wrapper exists (Phase 1), run `test/env/proxmox/pve-lab.sh` on the gateway node.
3. **Integration tests** run inside the lab against real Samba: provisioning, user CRUD, two-DC replication,
   Kea rendering, app install, Linux client join with realmd/sssd and login.
4. **E2E:** Playwright against the lab DC (setup wizard, user lifecycle, password reset, app install).
5. **Upgrade tests** (Phase 7): install N-1, deploy a profile, upgrade DCs one at a time, verify.
6. **CI:** lint, typecheck and unit tests on every push (hosted runners). VM tests run nightly on a
   self-hosted Linux runner with KVM, because hosted runners lack reliable nested virtualisation. The runner
   will be a VM on the Proxmox lab cluster that drives the lab through a scoped API token.
7. The Windows client join is a documented manual checklist (`test/manual/windows-join.md`) until a Windows
   VM image licence is sorted out.
