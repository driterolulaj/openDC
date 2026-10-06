# MyUCS roadmap

Each phase ends with a summary covering what was built, what was tested and the known gaps, then **stops for
the project owner's go-ahead**. Checkboxes are kept current. "Lab" means the VM topologies in `test/env/`.

---

## Phase 0: Design ✅ (awaiting review)
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
- [ ] **Project owner review; ADRs moved to Accepted or revised**

**Acceptance:** the project owner approves the design, answers the blocking open questions, and ADR statuses
are updated.

---

## Phase 1: Foundation
- [ ] **Spike S1 (first task):** in a lab DC on Samba from Debian 12 (backports per Q10), Debian 13 and
  Ubuntu 24.04, verify `msDS-App-Configuration` + `msDS-Settings` (create, size limit, replication between 2
  DCs) and `msDS-cloudExtensionAttribute*` for base schemas 2008_R2, 2012_R2 and 2016. Write the results into
  ADR-0003.
- [ ] **Spike S2:** DirSync control and change notification with `ldapts` against Samba (cookie round-trip,
  deletions, required rights).
- [ ] npm workspaces monorepo: `shared`, `api`, `agent`, `watcher`, `registry`, `os`, `cli`, `web`; TS project
  references; ESLint (incl. custom rules: no shell exec, no raw LDAP filters, no distro checks outside `os`),
  Prettier.
- [ ] `shared`: error codes, LDAP filter/DN escaping helpers, manifest Zod schema, `PlatformDb` interface
  (+ `node:sqlite` impl), permission names.
- [ ] `npm run gen` generator (manifests → per-target registries, allowlist) with tests.
- [ ] API skeleton: Fastify, Zod validator/serializer compilers, OpenAPI generation, sessions, CSRF, LDAPS login,
  RBAC engine (roles, OU scopes, tier-0 guard), audit log (append-only, hash chain), jobs and SSE.
- [ ] Agent: socket activation, JSON-RPC, per-socket allowlists, typed confirmation tokens, three operations
  (`system.info`, `service.status`, `file.writeManaged`).
- [ ] Config Registry: layers, typed keys, TS templates, managed-file headers, commit and rollback, drift diagnostic.
- [ ] OS adapter: Debian family (Debian 12/13, Ubuntu 24.04/26.04) `OsFacts` + the needed `OsActions`; support
  matrix; conformance test suite.
- [ ] Packaging: nfpm configs (`.deb`, `.rpm` skeleton), bundled Node runtime, hardened systemd units, tarball +
  `install.sh`.
- [ ] Test lab: `npm run lab -- up small|standard|multisite` (Incus primary).
- [ ] CI: lint, typecheck, unit tests, generated-file freshness and OpenAPI diff on every push; nightly VM job
  skeleton.

**Acceptance:**
1. `npm ci && npm run build && npm test` passes on Linux. Pure-logic tests also pass on Windows.
2. Unit coverage for escaping helpers, registry layering, template rendering, the allowlist (rejects unknown op,
   unknown socket, extra arg, path traversal) and RBAC scope evaluation is ≥ 95% lines.
3. In the `small` lab (Debian 13): the `.deb` installs, services start hardened (`systemd-analyze security`
   exposure ≤ 3.0 for api/watcher), and the console login page loads over HTTPS.
4. A test admin logs in through LDAPS against a pre-provisioned lab DC, sees an RBAC-filtered placeholder page,
   and the login is in the audit log.
5. `myucs registry set` on a demo key renders a managed file through the agent with the header, and the drift
   diagnostic flags a manual edit.
6. Spikes S1/S2 are documented, and ADR-0003/0004 are confirmed or amended (with approval).

---

## Phase 2: Domain core
- [ ] Setup wizard (web + `myucs setup` CLI): role selection, hostname/FQDN, realm/NetBIOS, network (apply
  with rollback), time, admin password; setup token.
- [ ] Pre-flight checks: DNS, time drift, ports, hostname validity (NetBIOS ≤ 15), disk, xattr/ACL,
  SELinux/AppArmor, port 53 conflict.
- [ ] Provision primary DC (`samba.provision`, RFC2307, 2012_R2/2016 schema choice); join additional DC
  (`samba.join`, writable); service accounts and delegations (ADR-0012); internal DNS and chrony with ntpsigned.
- [ ] FSMO view/transfer/seize (typed confirmation); functional level display/raise.
- [ ] Users (full attributes, status, expiry, unlock, reset, photo, Unix attributes, RID-based IDs), user
  templates, groups (nested, types), computers, OUs/containers, contacts.
- [ ] Password policies: domain default + PSOs (direct to users/groups). OU-linked password policies arrive with
  Phase 3 policies.
- [ ] Search with saved filters, bulk edit/move/delete/enable/disable, CSV import/export with dry-run diff.
- [ ] Object history view from the audit log.
- [ ] RBAC UI: roles, assignments, built-in Domain Admin / Helpdesk / Read-only Auditor.
- [ ] TOTP second factor; API tokens.
- [ ] CLI covering all Phase 2 API (generated from the OpenAPI operation list).
- [ ] i18n en/de complete for Phase 2 screens.

**Acceptance:**
1. In the `standard` lab: a fresh Debian 13 host is provisioned as the primary DC from the wizard in ≤ 15 minutes,
   and a second DC (Ubuntu 24.04) joins. `samba-tool drs showrepl` is clean.
2. A user created on dc1 through the console appears on dc2 within the replication interval, and the console on
   dc2 can edit it. Stopping dc1 still allows full user management on dc2.
3. A Helpdesk user scoped to `OU=Staff` can reset a password in `OU=Staff`, gets 403 outside it, and gets 403 for a
   Domain Admin account placed inside `OU=Staff` (tier-0 guard).
4. A Linux client in the lab joins with realmd/sssd and logs in as a console-created user with the RID-based UID.
5. A CSV import of 1,000 users shows a correct dry-run diff, applies, and is undoable through a bulk delete of
   the import batch.
6. Playwright: setup wizard, user lifecycle (create, edit, disable, reset, delete) green. axe reports no
   serious/critical violations on Phase 2 pages.
7. FSMO seizure requires typing the role names, and the audit log shows actor, before and after.

---

## Phase 3: Network services
- [ ] Watcher: DirSync/USN follower, per-DC checkpoints, full resync, handler quarantine, metrics.
- [ ] Policies module: policy types, links, enforced/priority, effective-policy viewer; registry `domain-policy`
  layer; OU-linked password policies through shadow groups + PSOs.
- [ ] DNS: zones (forward/reverse), records, auto-PTR, aging/scavenging, forwarders, DNS diagnostics (SRV,
  `_msdcs`, delegation); spike agent vs LDAP record writes.
- [ ] Kea DHCPv4/v6: subnets, pools, reservations, options from directory + DHCP policies; config-test before swap;
  lease viewer; HA pair; optional DNS registration (GSS-TSIG or lease hook, per spike).
- [ ] PKI: root + per-DC issuing CAs, node/service/web/LDAPS certificates, revocation, CRL publication, expiry
  warnings, auto-renew; ACME via the chosen client.
- [ ] GPO: list/backup/restore/link/unlink.

**Acceptance:**
1. Editing a DHCP reservation on dc2 changes the rendered Kea config on the member serving that subnet within 30 s
   (same site), with no Kea restart beyond `config-reload`.
2. Killing the watcher mid-batch and restarting it reaches the same end state (idempotency test). Failing over
   the watcher's home DC triggers a full resync, logged and metered.
3. The effective-policy viewer matches the resolver unit tests on a 5-level OU fixture with enforced links.
4. A user moved into an OU with a stricter password policy gets that PSO (`msDS-ResultantPSO`) within one watcher
   cycle.
5. Console, LDAPS and node certificates are issued by the internal CA, renew automatically in a time-shifted
   test, and a revoked node certificate is refused on node RPC.
6. DNS diagnostics detect a deliberately deleted `_ldap._tcp` SRV record and suggest the fix.

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
- [ ] Deployment profiles: versioned YAML schema, wizard export/import, `myucs deploy --profile` with dry-run
  plan; starter templates (small office, school, multi-site company).
- [ ] DC demotion and removal of dead DCs.

**Acceptance:**
1. `multisite` lab (80 ms latency between sites): 3 DCs incl. RODC deployed from `multi-site-company.yaml` by
   `myucs deploy` in under 60 minutes, end to end, unattended. Dry-run output matches what was applied.
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
  SPNEGO), mail stack (Postfix/Dovecot).
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
4. Windows Server 2019/2022 AD at FL ≤ 2016 migrates to MyUCS DCs in the lab with clients keeping their trust.

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
