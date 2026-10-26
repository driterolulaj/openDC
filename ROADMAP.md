# OpenDC roadmap

Each phase ends with a summary covering what was built, what was tested and the known gaps, then **stops for
the project owner's go-ahead**. Checkboxes are kept current. "Lab" means the VM topologies in `test/env/`.

---

## Phase 0: Design ✅ (reviewed 2026-10-24)
- [x] `CLAUDE.md`
- [x] `docs/ARCHITECTURE.md` with Mermaid diagrams
- [x] ADRs 0001–0022 (`docs/adr/`)
- [x] `docs/DEPENDENCIES.md`
- [x] `docs/SECURITY.md` (threat model)
- [x] Module manifest interface (`docs/design/module-manifest.ts`)
- [x] Agent operation catalogue (`docs/design/agent-operations.md`)
- [x] Directory object model, including the reserved schema-extension design (`docs/design/directory-object-model.md`)
- [x] OS adapter interface (`docs/design/os-adapter.ts`)
- [x] `ROADMAP.md`
- [x] Open questions (`docs/OPEN-QUESTIONS.md`)
- [x] **Project owner review; ADRs moved to Accepted or revised** (2026-10-24; ADR-0021 waits for Q7, ADR-0023 added for the license)

**Acceptance:** the project owner approves the design, answers the blocking open questions, and ADR statuses
are updated.

---

## Phase 1: Foundation ✅ (2026-10-24, awaiting the project owner's go-ahead)
- [x] **Spike S1 (first task):** in a lab DC on Samba from Debian 12 (backports per Q10), Debian 13 and
  Ubuntu 24.04, verify `msDS-App-Configuration` + `msDS-Settings` (create, size limit, replication between 2
  DCs) and `msDS-cloudExtensionAttribute*` for base schemas 2008_R2, 2012_R2 and 2016. Write the results into
  ADR-0003.
  *Gate passes; `docs/spikes/S1-app-configuration.md`, written into ADR-0003.*
- [x] **Spike S2:** DirSync control and change notification with `ldapts` against Samba (cookie round-trip,
  deletions, required rights).
  *DirSync works with an in-house control; change notification needs a streaming reader that `ldapts` lacks.
  `docs/spikes/S2-dirsync.md`; written into ADR-0004 (Q20).*
- [x] npm workspaces monorepo: `shared`, `api`, `agent`, `watcher`, `registry`, `os`, `cli`, `web`; TS project
  references; ESLint (incl. custom rules: no shell exec, no raw LDAP filters, no distro checks outside `os`),
  Prettier. *Plus `modules` and a no-literal-JSX-text rule.*
- [x] `shared`: error codes, LDAP filter/DN escaping helpers, manifest Zod schema, `PlatformDb` interface
  (+ `node:sqlite` impl), permission names.
- [x] `npm run gen` generator (manifests → per-target registries, allowlist) with tests.
- [x] API skeleton: Fastify, Zod validator/serializer compilers, OpenAPI generation, sessions, CSRF, LDAPS login,
  RBAC engine (roles, OU scopes, tier-0 guard), audit log (append-only, hash chain), jobs and SSE.
- [x] Agent: socket activation, JSON-RPC, per-socket allowlists, typed confirmation tokens, three operations
  (`system.info`, `service.status`, `file.writeManaged`). *Plus `samba.version`, `service.start/stop/restart/reload`,
  `file.readManaged/restorePrevious`, `registry.commitLock` and `--init-secrets`.*
- [x] Config Registry: layers, typed keys, TS templates, managed-file headers, commit and rollback, drift diagnostic.
- [x] OS adapter: Debian family (Debian 12/13, Ubuntu 24.04/26.04) `OsFacts` + the needed `OsActions`; support
  matrix; conformance test suite. *Conformance run on Debian 13 and Ubuntu 24.04 lab hosts.*
- [ ] Packaging: nfpm configs (`.deb`, `.rpm` skeleton), bundled Node runtime, hardened systemd units, tarball +
  `install.sh`. *Done except the `.rpm` skeleton (the RHEL family arrives in Phase 6) and package signing.*
- [ ] Test lab: `npm run lab -- up small|standard|multisite` (Proxmox VE primary, Incus secondary; ADR-0015).
  *`npm run lab` drives `test/env/proxmox/pve-lab.sh` for `small`, `standard`, `ci` and `spike`; `multisite` and
  the Incus backend are not built yet.*
- [x] CI: lint, typecheck, unit tests, generated-file freshness and OpenAPI diff on every push; nightly VM job
  skeleton. *In `.github/workflows/`, running on GitHub (Q13).*

**Acceptance:**
1. `npm ci && npm run build && npm test` passes on Linux. Pure-logic tests also pass on Windows.
   **Met:** `npm run check` on build1 (Debian 13) and on Windows: 103 backend + 4 web tests.
2. Unit coverage for escaping helpers, registry layering, template rendering, the allowlist (rejects unknown op,
   unknown socket, extra arg, path traversal) and RBAC scope evaluation is ≥ 95% lines.
   **Met:** 99.9% lines (`npm run test:coverage` enforces 95%).
3. In the `small` lab (Debian 13): the `.deb` installs, services start hardened (`systemd-analyze security`
   exposure ≤ 3.0 for api/watcher), and the console login page loads over HTTPS.
   **Met:** exposure 1.3 for both, also on Ubuntu 24.04 (sclient1).
4. A test admin logs in through LDAPS against a pre-provisioned lab DC, sees an RBAC-filtered placeholder page,
   and the login is in the audit log.
   **Met:** Administrator via LDAPS, Domain Admin role resolved from tokenGroups, a non-admin refused, audit
   entries for success, denial and failure.
5. `opendc registry set` on a demo key renders a managed file through the agent with the header, and the drift
   diagnostic flags a manual edit.
   **Met**, and `opendc registry commit` repairs the drift.
6. Spikes S1/S2 are documented, and ADR-0003/0004 are confirmed or amended (with approval).
   **Met:** S1 written into ADR-0003, S2 into ADR-0004.

---

## Phase 2: Domain core
- [x] Setup wizard (web + `opendc setup` CLI): role selection, hostname/FQDN, realm/NetBIOS, time, admin
  password; setup token. *Network apply-with-rollback moved to Phase 6 (Q23); pre-flight requires a static
  address.*
- [x] Pre-flight checks: DNS, time drift, ports, hostname validity (NetBIOS ≤ 15), disk, xattr/ACL,
  SELinux/AppArmor, port 53 conflict.
- [x] Provision primary DC (`samba.provision`, RFC2307, 2012_R2/2016 schema choice); join additional DC
  (`samba.join`, writable); service accounts and delegations (ADR-0012); internal DNS and chrony with ntpsigned.
- [x] FSMO view/transfer/seize (typed confirmation); functional level display/raise.
- [x] Users (full attributes, status, expiry, unlock, reset, photo, Unix attributes, RID-based IDs), user
  templates, groups (nested, types), computers, OUs/containers, contacts.
- [x] Password policies: domain default + PSOs (direct to users/groups). OU-linked password policies arrive with
  Phase 3 policies.
- [x] Search with saved filters, bulk edit/move/delete/enable/disable, CSV import/export with dry-run diff.
- [x] Object history view from the audit log.
- [x] RBAC UI: roles, assignments, built-in Domain Admin / Helpdesk / Read-only Auditor.
- [x] TOTP second factor; API tokens.
- [x] CLI covering all Phase 2 API (generated from the OpenAPI operation list).
- [x] i18n en/de complete for Phase 2 screens.

**Acceptance:**
1. In the `standard` lab: a fresh Debian 13 host is provisioned as the primary DC from the wizard in ≤ 15 minutes,
   and a second DC (Ubuntu 24.04) joins. `samba-tool drs showrepl` is clean.
   **Met:** dc1 (Debian 13) provisioned and dc2 (Ubuntu 24.04) joined from the web wizard by the owner;
   showrepl ALL GOOD both ways. Scripted: wizard to a new domain in 36 s (Playwright), CLI join in 22 s.
2. A user created on dc1 through the console appears on dc2 within the replication interval, and the console on
   dc2 can edit it. Stopping dc1 still allows full user management on dc2.
   **Met:** visible on dc2 after 5 s, dc2 edit on dc1 after 5 s; with dc1 stopped: login (TOTP), create, edit,
   reset, list on dc2; dc1 caught up on restart.
3. A Helpdesk user scoped to `OU=Staff` can reset a password in `OU=Staff`, gets 403 outside it, and gets 403 for a
   Domain Admin account placed inside `OU=Staff` (tier-0 guard).
   **Met:** 200 / 403 / 403.
4. A Linux client in the lab joins with realmd/sssd and logs in as a console-created user with the RID-based UID.
   **Met:** client1 (Ubuntu 24.04, `roles/linux-client.sh`): RID 1111 -> uid 101111, gid 100513, SSH password
   login with home directory.
5. A CSV import of 1,000 users shows a correct dry-run diff, applies, and is undoable through a bulk delete of
   the import batch.
   **Met:** dry run 0.3 s, apply 37 s (one-time password download), undo 10 s.
6. Playwright: setup wizard, user lifecycle (create, edit, disable, reset, delete) green. axe reports no
   serious/critical violations on Phase 2 pages.
   **Met:** `setup.spec.ts` and `users.spec.ts` (incl. TOTP enrolment and the code prompt) green, axe clean.
7. FSMO seizure requires typing the role names, and the audit log shows actor, before and after.
   **Met:** wrong phrase refused (`agent.confirmation-required`); all 7 roles seized in 2 s; audit entry with actor,
   before and after; the old holder sees the new one after restart; SDProp follows the PDC role.

---

## Phase 3: Network services
- [x] Watcher: DirSync/USN follower, per-DC checkpoints, full resync, handler quarantine, metrics. *DirSync only
  (the uSNChanged fallback isn't needed on Samba 4.22); the watch account may read tombstones (Q24, approved 2026-10-26).*
- [x] POSIX IDs for users and groups created outside OpenDC: watcher handler and a bulk action (ADR-0018, Q22).
- [x] Policies module: policy types, links, enforced/priority, effective-policy viewer; registry `domain-policy`
  layer; OU-linked password policies through shadow groups + PSOs. *Types so far: password, registry; DHCP
  policies arrive with Kea, the others with their phases.*
- [x] DNS: zones (forward/reverse), records, auto-PTR, aging/scavenging, forwarders, DNS diagnostics (SRV,
  `_msdcs`, delegation); spike agent vs LDAP record writes. *Spike S3: writes through the agent, reads over LDAP.
  Forwarders/scavenging are per DC (the DC the console runs on until node RPC in Phase 4).*
- [x] Kea DHCPv4/v6: subnets, pools, reservations, options from directory + DHCP policies; config-test before swap;
  lease viewer; HA pair; optional DNS registration (GSS-TSIG or lease hook, per spike). *The optional DNS
  registration is decided (Q25 (a): reconcile A/PTR from the leases) and still to be built. Built: services (one
  server or an HA pair over mutual TLS), IPv4 and IPv6 subnets, pools, reservations (IPv6 by DUID or MAC),
  options, DHCP policies (server-wide IPv4 options), `kea-dhcp4/6 -t` as `_kea` before the swap,
  `config-reload`, lease viewer; each daemon runs only while the node serves subnets of its family.*
- [ ] PKI: root + per-DC issuing CAs, node/service/web/LDAPS certificates, revocation, CRL publication, expiry
  warnings, auto-renew; ACME via the chosen client. *Done except ACME (decided, Q7: nginx front proxy + lego; still to be built) and expiry warnings in the
  diagnostics framework (Phase 4); a DC's issuing CA needs a tier-0 approval on the root holder.*
- [x] GPO: list/backup/restore/link/unlink. *Listed over LDAP; create, backup and restore run on the PDC emulator
  with the DC's local privileges (samba-tool's own commands write SYSVOL over SMB with an account's
  credentials): the container through `sam.ldb`, the folder on disk, then `ntacl sysvolreset`. The new folders
  get the same ACL as the provisioned default GPOs. Restores land above the current and the backed-up version
  so clients reapply them, in place or as a new GPO. Backups stay on the PDC emulator until backup targets
  (Phase 4). Links on the domain and the Domain Controllers OU, and all restores, are tier 0. Note:
  `samba-tool ntacl sysvolcheck` flags the folder owner `sysvolreset` sets (LA instead of DA) on every GPO,
  the provisioned ones included; the DACLs match.*

**Acceptance:**
1. Editing a DHCP reservation on dc2 changes the rendered Kea config on the member serving that subnet within 30 s
   (same site), with no Kea restart beyond `config-reload`.
   **Met:** member1 (Kea 2.6.3) rendered the changed reservation 3.2 s after the edit through dc2's API. Kea
   applied it with `config-reload` (`DHCP4_DYNAMIC_RECONFIGURATION`), same PID.
2. Killing the watcher mid-batch and restarting it reaches the same end state (idempotency test). Failing over
   the watcher's home DC triggers a full resync, logged and metered.
   **Met:** idempotency: watcher killed (SIGKILL) at 20/150 users, all 150 filled after the restart, no
   duplicate IDs, one audit entry each. Failover: with Samba stopped on dc1, member1's watcher moved to dc2 within
   5 s. Every handler logged a full resync ("another DC") and counted it (`resyncs` 1). A reservation edited on dc2
   meanwhile reached member1's Kea in 2.6 s.
3. The effective-policy viewer matches the resolver unit tests on a 5-level OU fixture with enforced links.
   **Met:** the fixture (`packages/shared/src/policy/fixture.ts`) built in the lab; the viewer's order equals the
   unit test's, group and node-role filters included.
4. A user moved into an OU with a stricter password policy gets that PSO (`msDS-ResultantPSO`) within one watcher
   cycle.
   **Met:** PSO after 6.5 s (5 s poll), gone 6.3 s after moving out; a 13-character password is refused inside the
   16-character OU and accepted outside.
5. Console, LDAPS and node certificates are issued by the internal CA, renew automatically in a time-shifted
   test, and a revoked node certificate is refused on node RPC.
   **Met:** dc1 and dc2 serve console, LDAPS and node RPC certificates from their issuing CAs; renewal at 2/3 of
   the life is unit-tested with a shifted clock and ran in the lab through the timer; a revoked node certificate
   was refused 47 s after the revocation (`CERT_REVOKED`), and the node replaced it on its own.
6. DNS diagnostics detect a deliberately deleted `_ldap._tcp` SRV record and suggest the fix.
   **Met:** dc2's `_ldap._tcp` SRV deleted: reported missing on both DNS servers with the fix; "Repair" re-created
   it (tier 0) and the next run passed 59/59.

---

## Phase 4: Multi-node and multi-site
- [ ] Sites, subnets and site links UI; site-aware home-DC selection for nodes.
- [ ] Read-only DC join (with documented Samba limits); write proxy from RODC API to a writable DC.
- [ ] Member servers and managed nodes: enrolment, node certificates, node inventory (role, OS, versions,
  health, last seen).
- [ ] Remote agent actions over node mTLS: service control, diagnostics, registry, updates (hook for Phase 6).
- [ ] SYSVOL replication (ADR-0019) and idmap seeding.
- [ ] Audit log replication between writable DCs.
- [ ] Diagnostics framework + checks: replication, DNS SRV, time skew, cert expiry, disk, failed units,
  keytab validity, sysvol consistency, idmap consistency, leader health. Prometheus `/metrics`, `/health`,
  journald log viewer.
- [ ] Backup/restore: online/offline domain backup, registry, CA, platform DB; schedules, retention, rsync/SFTP
  targets, encryption; restore runbooks (full-domain DR vs single-DC re-join).
- [ ] Deployment profiles: versioned YAML schema, wizard export/import, `opendc deploy --profile` with dry-run
  plan; starter templates (small office, school, multi-site company).
- [ ] DC demotion and removal of dead DCs.

**Acceptance:**
1. `multisite` lab (80 ms latency between sites): 3 DCs incl. RODC deployed from `multi-site-company.yaml` by
   `opendc deploy` in under 60 minutes, end to end, unattended. Dry-run output matches what was applied.
2. A branch client authenticates against the branch RODC (verified via logs). A password change from the branch
   console is proxied to a hub DC and replicates back.
3. A GPO edited on the PDC emulator reaches every DC's SYSVOL within 5 minutes, and the sysvol diagnostic is green.
4. Diagnostics flag (a) stopped replication, (b) 7 min time skew on dc2 with the message pattern
   "Time skew 7m exceeds Kerberos 5m limit; check chrony on dc2", (c) a certificate expiring in 10 days.
5. CI restore test: back up dc1 in `small`, destroy it, restore onto a fresh VM from the backup and the runbook;
   users, platform objects and CA verified.
6. Each starter template deploys into a fresh lab in nightly CI.
7. Demoting a DC leaves no stale DNS/NTDS objects (dbcheck clean).

---

## Phase 5: App Center, portal, self-service, Keycloak SSO
- [ ] Signed catalog (Ed25519, multiple sources, pinned keys); app manifest schema.
- [ ] Install/configure/start/stop/upgrade (with pre-upgrade snapshot)/uninstall (keep data option)/logs; Podman
  (rootless where possible) or Docker through the adapter; quadlet units.
- [ ] Directory integration: service accounts, LDAP bind/filters, OIDC clients, portal tiles, registry keys,
  backup paths.
- [ ] First-party test apps: static app, Nextcloud (LDAP), Keycloak (SSO, LDAP federation to Samba, optional
  SPNEGO).
- [ ] **Mail module (first-class platform service, Q19):** Postfix + Dovecot on member servers (or a DC in small
  sites) through the OS adapter. It covers:
  - mailboxes for domain users (from `mail`/`proxyAddresses`), authenticated against the domain (LDAP, Kerberos)
  - aliases and distribution lists from AD groups
  - TLS certificates from the internal CA
  - MX, SPF and DKIM records through the DNS module
  - local delivery first, with an optional outbound relay
  - the platform's own mail (password reset, notifications) goes through it by default
  
  This needs a new ADR before implementation.
- [ ] Portal: categories, group-based visibility, branding, console editing.
- [ ] Self-service: password change with policy feedback, reset by mail token, whitelisted profile edits,
  optional registration with approval.
- [ ] Console OIDC login once Keycloak is installed.

**Acceptance:**
1. Installing Keycloak from the catalog yields working SSO into the console and Nextcloud for a domain user with
   no manual configuration. Kerberos SPNEGO works from a domain-joined Linux client browser.
2. A tampered catalog signature or image digest is refused by the agent even if the API is bypassed (test calls
   the agent socket directly).
3. An app upgrade with a failing post-upgrade health check rolls back to the snapshot automatically.
4. Password reset: token is single-use, expires, is rate-limited, and responses don't reveal whether an account
   exists (tested).
5. Playwright: password reset and app install flows green.

---

## Phase 6: File/print, updates, other distros, Samba container mode
- [ ] SMB shares (member servers and DCs with a warning): ACLs, quotas, home directories on first login.
- [ ] NFS exports with `sec=krb5*` options.
- [ ] CUPS printers, SMB publishing, printer groups; honest Point-and-Print documentation.
- [ ] OS updates (check/schedule/apply, reboot indicator, maintenance windows by policy); platform updates
  (signed repo, stable/testing); app updates.
- [ ] RHEL-family and SUSE adapters (member/managed native; DC through container mode); Arch/Alpine agent-only
  (Tier 2).
- [ ] Samba AD DC container image: build, sign, SBOM, GPL source publication, security-update pipeline.
- [ ] Setup wizard network step: apply the address configuration with automatic rollback unless confirmed
  through the new address (moved from Phase 2, Q23).

**Acceptance:**
1. Rocky 9 DC in container mode joins the Debian-based `standard` lab domain; replication clean, console works
   on it.
2. Native DC role on Rocky is refused at pre-flight with a message pointing to container mode.
3. A Windows client (manual checklist) maps a home share created on first login with correct ACLs and quota.
4. A scheduled OS update on a member applies inside its maintenance window and reports reboot-required.
5. The adapter conformance suite passes for debian, rhel and suse adapters in nightly CI.

---

## Phase 7: Productization
- [ ] Fleet console (separate component): outbound mTLS enrolment, health/inventory/alerts, job push, deep links,
  revocation; isolation tests.
- [ ] White-labeling at runtime (name, logo, colors, support contact, portal/login text).
- [ ] Support bundle (redacted, previewable); opt-in anonymous telemetry, off by default.
- [ ] Release engineering: semver, LTS line and support window, `/api/v1` stability + deprecation policy,
  rolling-upgrade support for mixed-version DCs; Node runtime line decision (Q9).
- [ ] Migrations: join existing Windows AD as DC → transfer FSMO → retire Windows DCs (guided); CSV/LDIF import;
  documented UCS migration path.
- [ ] Sizing guide; load tests (50k users, 10k groups, 100 nodes).
- [ ] GDPR tooling: personal-data export, erasure (incl. audit pseudonymisation), retention settings; auditor
  documentation pack.

**Acceptance:**
1. Upgrade test: release N-1 + profile deployed → rolling upgrade one DC at a time → all diagnostics green; the
   console is usable throughout.
2. Fleet isolation: with the fleet link connected, a packet capture/test proves only allowlisted metadata
   fields leave the client; revoking the link from the client stops all traffic; the fleet console can't write
   without a grant.
3. Load: with 50k users / 10k groups, list pages p95 < 500 ms, search p95 < 1 s, a watcher full resync of the
   platform container < 60 s, and a user-subtree resync < 5 min (documented hardware).
4. Windows Server 2019/2022 AD at FL ≤ 2016 migrates to OpenDC DCs in the lab with clients keeping their trust.

---

## Phase 8: Connectors, hardening, documentation, 1.0 LTS
- [ ] Connectors as apps: external AD sync (one-way, two-way), Microsoft 365 / Entra ID, Google Workspace,
  generic webhooks from the watcher.
- [ ] Security hardening pass: external review, fuzzing of parsers (CSV, LDIF, profiles, LDAP controls),
  revisit residual risk #2 (confirmation key separation).
- [ ] Documentation sets: integrators, client administrators, end users (en/de).
- [ ] 1.0 LTS release.

**Acceptance:**
1. External security review findings rated high/critical are fixed or have an accepted risk decision from the
   project owner.
2. All three documentation sets are published and cover every console page.
3. The full nightly matrix (Tier 1 DC + member, Tier 2 smoke) is green for 14 consecutive days before the release.
