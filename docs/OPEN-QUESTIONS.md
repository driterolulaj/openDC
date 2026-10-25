# Open questions for the project owner

**B** = blocks Phase 1. **L** = needed later (phase noted). Each question has a recommendation.

**Status 2026-10-25:** all blocking questions are answered (marked inline). Still open: Q2 (IANA PEN, before any
schema work), Q7 (front proxy and ACME, needed for the ACME part of Phase 3), Q9, Q14–Q16.

## A. Naming, legal, identifiers

**Q1 (B) — Product name.** *Answered 2026-10-24: **OpenDC**, id `opendc`.* The working name "MyUCS" came from the folder. "UCS" is Univention's product
name and likely a trademark, so for a product sold through integrators I recommend a distinct name before
Phase 1. The lowercase id (`opendc`) ends up in package names, system users, paths and the directory
container `CN=<Name>,CN=System`. **The directory container name is effectively permanent once client
domains exist.**

**Q2 (L, before any schema work) — IANA Private Enterprise Number.** Free, takes days to weeks. I recommend
requesting one now even though no schema extension is planned, so the OID arc is ready.

**Q12 (B) — Project license.** *Answered 2026-10-24: AGPL-3.0 (ADR-0023).* This affects:
- distribution of the Samba container image (GPLv3, so we must publish corresponding source)
- which dependencies are acceptable
- whether the fleet console can be closed source

Options: AGPL-3.0 (like UCS), Apache-2.0/MIT, or proprietary with an open core.

## B. Decisions where I propose deviating from or adding to the spec

**Q3 (B) — Schema.** *Answered 2026-10-24: approved.* Approve "**no schema extension for the MVP**" (ADR-0003):
- platform objects use `msDS-App-Configuration`
- extended attributes use the 20 `msDS-cloudExtensionAttribute*` slots
- the reserved extension design in `design/directory-object-model.md` §5 is for later review only

**Q4 (B) — Directory bind model** (ADR-0012). *Answered 2026-10-24: delegated service accounts.* Approve:
- a delegated, non-tier-0 service account per writable DC
- tier-0 operations through the agent on a DC

The alternative (a single Domain Admin service account) is simpler but much riskier.

**Q5 (B) — Console login** (ADR-0020). *Answered 2026-10-24: approved.* Approve LDAPS simple bind against a TLS-verified DC instead of
"Kerberos-verified credentials". A verified TLS channel already prevents the KDC spoofing that Kerberos
verification guards against, and we avoid a native GSSAPI addon.

**Q6 (B) — Spec corrections.** *Answered 2026-10-24: all confirmed (a–i).* Please confirm each:
- a. **OU-linked password policies** become PSOs plus auto-maintained shadow groups, because AD PSOs can't link
  to OUs (directory model §3.2).
- b. **No generic `samba.tool(args[])` agent operation.** Typed operations per subcommand instead, because the
  generic form amounts to arbitrary root and domain-admin access (ADR-0006).
- c. **SYSVOL replication added** (ADR-0019). Samba doesn't replicate SYSVOL, and the spec doesn't mention it.
- d. **Backup and restore semantics.** `samba-tool domain backup` restore is for whole-domain disaster recovery.
  Replacing a single failed DC is a re-join. The runbooks treat these separately.
- e. **RODC.** Samba RODC support is limited. RODCs are supported for branch authentication and reads, the
  console on an RODC is read-only, and writes are proxied to a writable DC.
- f. **Kea DDNS against Samba internal DNS** needs GSS-TSIG. Depending on the Kea version, we use either Kea's
  GSS-TSIG hook or a OpenDC lease hook. Decided by a spike in Phase 3.
- g. **Leader for singleton jobs = PDC emulator holder** (ADR-0017), rather than a new consensus mechanism.
- h. **CA design:** a root CA plus one issuing CA per writable DC, with the root key optionally taken offline
  (ADR-0007). The spec implies a single CA.
- i. **Audit log:** node-local SQLite with conflict-free pull replication between writable DCs (ADR-0013),
  rather than storing audit entries in AD.

**Q7 (B for Phase 3, L otherwise) — Front proxy and ACME** (ADR-0021).
- I recommend **nginx** (distro package) as the HTTPS front proxy for the console and apps, and **lego** as the
  ACME client.
- nginx is a new orchestrated component that isn't in spec §4.
- Alternative: Caddy (proxy and ACME in one binary).

## C. Dependencies (see `docs/DEPENDENCIES.md`, "Pending approval")

**Q8 (B) — Approve the implied and new packages:** *Answered 2026-10-24: all approved.*
- `react-i18next`
- `@mantine/notifications`, `@mantine/dates`, `@mantine/form`
- `postcss` + `postcss-preset-mantine`
- `@vitejs/plugin-react`
- `@types/*`
- `typescript-eslint`, `eslint-plugin-react-hooks`
- `jsdom` (or `happy-dom`), optionally `@testing-library/react`
- `@axe-core/playwright`
- `@cyclonedx/cyclonedx-npm`
- **`yaml` (Phase 4)** for deployment profiles; alternatively profiles could be JSON
- bundling the official Node.js binary in our packages (ADR-0010)

## D. Platform baselines

**Q9 (L, Phase 7) — Node.js line for 1.0 LTS.** Node 24 enters maintenance this month (October 2026) and reaches
end of life in April 2028. I recommend building on 24 now and deciding at the start of Phase 7 whether 1.0 ships
on the next LTS line so it covers the published support window.

**Q10 (B) — Minimum Samba version for the DC role.** *Answered 2026-10-24: Debian 12 DCs require bookworm-backports. Implemented as `MIN_DC_SAMBA = 4.19` in packages/os: the oldest Samba shipped in a security-supported Tier-1 release (Ubuntu 24.04), because a literal "oldest maintained upstream" (about 4.23 today) would exclude Debian 13 and Ubuntu 24.04. Revisit at each release.* Debian 12 ships Samba 4.17, which is no longer supported
upstream (Debian still backports security fixes), and newer versions are in `bookworm-backports`. Proposal:
- set the minimum to the oldest Samba still maintained upstream at each OpenDC release
- on Debian 12, require backports for the DC role
- capability-gate newer features (gMSA, FL 2016) by detected version

The alternative is to drop Debian 12 as a DC platform and keep it for members only.

## E. Development environment

**Q11 (B) — Where the VM lab runs, and where the repo lives.** *Answered 2026-10-24: lab on a 2-node Proxmox VE
cluster (ADR-0015 amended); repo moved out of OneDrive to a local, non-synced folder.*
- This machine is **Windows 11**, and the project sits in a **OneDrive-synced folder**. `node_modules` and `.git`
  inside OneDrive cause sync storms and file locking. I recommend moving the repo to a non-synced path, ideally
  inside WSL2 (e.g. `~/src/opendc`).
- The lab needs **Linux with KVM** (Incus VMs, ADR-0015). Options:
  - (a) WSL2 with nested virtualisation on this machine. Works for `small`/`standard`; `multisite` (6+ VMs) may
    be tight on RAM.
  - (b) A separate Linux box or Proxmox host reachable from here.
  - (c) A cloud VM with nested virtualisation.

  Which do you have? Nightly CI also needs a self-hosted runner with KVM.

**Q13 (L) — Git hosting and CI.** *Answered 2026-10-24: GitHub, https://github.com/driterolulaj/openDC (GitHub Actions).* GitHub Actions is assumed for push CI. Confirm, or tell me what you use
(GitLab/Gitea/...).

## F. Product details (later phases)

**Q14 (L, Phase 2):**
- default `idBase` for UIDs/GIDs (proposed 100000)
- default OU skeleton for new domains (proposed: no extra OUs beyond the AD defaults plus
  `OU=OpenDC Service Accounts` and `OU=OpenDC Shadow Groups`, with the rest coming from deployment profiles)

**Q15 (L, Phase 7) — Fleet console stack.** Same stack, separate deployable, own DB (SQLite or Postgres?). Is
the fleet console part of the open product or a separate commercial component?

**Q16 (L, Phase 4) — Backup encryption format.** `openssl enc` (AES-256-GCM via a CMS envelope) or an age-style
format implemented with `node:crypto`. I recommend a small, documented envelope on `node:crypto` so restores
don't depend on any particular openssl version.

## G. Raised 2026-10-24

**Q17 (L, before the repository goes public) — Contributor agreement.** *Answered 2026-10-24: DCO.* With AGPL-3.0-only (ADR-0023), a CLA
keeps the option of dual-licensing (for example a closed fleet console, Q15), and a DCO (`Signed-off-by`)
is lighter for contributors. I recommend a DCO unless dual-licensing is a real plan.

**Q18 (L, Phase 2) — Service account names exceed the AD limit.** *Answered 2026-10-24: approved, ADR-0012 §3.* `sAMAccountName` allows at most 20
characters. `opendc-svc-<host>` with a 15-character NetBIOS host name is 26 (the old `myucs-svc-` was already
25). Proposal for ADR-0012 and the directory model §1:
- the CN and `displayName` keep the readable `opendc-svc-<host>` / `opendc-watch-<host>` / `opendc-ro-<host>`
- `sAMAccountName` becomes `odcs-<host>`, `odcw-<host>` and `odcr-<host>`, at most 20 characters because
  pre-flight caps host names at 15 characters

## H. Raised at the end of Phase 1 (2026-10-24)

**Q19 (L, before the first public package) — Project contact and domain.** *Answered 2026-10-24: a mail server becomes part of the platform (ROADMAP Phase 5, mail module); until then contacts are local (`maintainers@localhost`, `security@localhost`; `OPENDC_MAINTAINER` overrides the package field).* The packages and the
vulnerability-disclosure placeholder use `maintainers@opendc.invalid` / `security@<project domain>`. Which
domain and addresses should packages, SECURITY.md and the console's "Source code" link (ADR-0023) use?

**Q20 (B for Phase 3) — Approve the ADR-0004 amendment from Spike S2** *Answered 2026-10-24: approved, written into ADR-0004.* (`docs/spikes/S2-dirsync.md`):
- the watcher polls DirSync (default 5 s) instead of relying on change notification, which `ldapts` can't
  stream
- the watch account gets DS-Replication-Get-Changes on the domain head, and nothing broader
- an optional streaming wake-up reader is decided in Phase 3

## I. Raised during Phase 2 (2026-10-25)

**Q21 (B, before Phase 2 ends) — Samba has no SDProp; approve OpenDC's own (ADR-0012 premise).** *Answered 2026-10-25: approved, written into ADR-0012.* ADR-0012
assumes the delegated account `opendc-svc-<host>` "can't modify protected accounts" because AdminSDHolder
blocks inheritance on them. Tested on Samba 4.22: it doesn't. Administrator has `adminCount=1` but an
unprotected DACL (`D:AI`), and new members of Domain Admins get neither `adminCount` nor a protected DACL, so
the delegation granted on the domain head reaches them. The delegated account could reset a Domain Admin's
password. **Implemented (pending your approval):**
- a new agent operation `samba.sdprop.run` (catalogue §3.3) that does what the Windows SDProp task does. For
  every member (transitive) of a protected group, the groups themselves, Administrator and krbtgt, it sets
  `adminCount=1` and a protected DACL: AdminSDHolder's explicit ACEs plus the Windows defaults Samba's copy
  lacks (BA/EA full control, change password for Everyone and SELF). It writes only the DACL (SD flags 4).
- it runs at the end of setup, after OpenDC's own tier-0 changes, and from `opendc-sdprop.timer` every
  15 minutes on the PDC emulator only (Windows: 60 minutes)
- the API additionally treats an object as tier 0 when it is protected by `adminCount` or by transitive
  membership in a protected group, so the guard holds even inside the 15-minute window
- verified in the lab: before the run the delegated account can modify a new Domain Admin; afterwards it
  can't, while ordinary users stay writable. The second run changes nothing.

Alternatives: (a) narrow the delegation to OpenDC-managed OUs only (then default users in `CN=Users`
can't be managed), (b) leave the API guard as the only barrier (contradicts ADR-0012's consequences
section). If you approve, I'll add a short amendment to ADR-0012.

**Q22 (C, Phase 3) — POSIX IDs for objects created outside OpenDC.** *Answered 2026-10-25: (a) and (b), written into ADR-0018.* ADR-0018 writes `idBase + RID` when
OpenDC creates a user or group. Accounts created with RSAT, `samba-tool` or a migration have no `uidNumber`,
and Linux members with `ldap_id_mapping = False` don't see them at all (seen in the lab: a `samba-tool` user is
missing from `getent` on client1; console users resolve). Options: (a) the watcher (Phase 3) fills in missing
values for new users and groups, using the same rule, and logs each one in the audit; (b) a "Fill in POSIX IDs"
bulk action only; (c) leave as is and document it. Recommendation: (a) plus (b) for existing objects.

**Q23 (B, before Phase 2 ends) — Network apply-with-rollback in the setup wizard.** *Answered 2026-10-25: (b), moved to Phase 6.* The roadmap lists it;
it isn't built. Pre-flight requires a static address and tells the admin to set one (all lab hosts and most
servers already have one). Options: (a) build it now: the wizard writes the netplan/ifupdown/NetworkManager
config, applies it, and rolls back unless the browser confirms through the new address within 120 s;
(b) move it to Phase 6 (appliance/ISO), where OpenDC owns the network configuration anyway.
Recommendation: (b); it touches three network stacks and is the riskiest step of setup for little gain on
hosts that already run.

## J. Raised during Phase 3 (2026-10-25)

**Q24 (B, before Phase 3 ends) — The watch account needs read access to `CN=Deleted Objects` (ADR-0004/0012).**
DirSync silently drops tombstones for an account that can't read `CN=Deleted Objects`, whose default DACL admits
only SYSTEM and Administrators. Spike S2 saw tombstones because it ran as Administrator; the delegated watch
account `odcw-<host>` didn't, so deletions (a deleted policy, later a deleted DHCP reservation) were never seen.
**Implemented (pending your approval):** each DC's watch account gets one more ACE, `(A;;LCRP;;;<sid>)` (list
contents, read properties) on `CN=Deleted Objects`, appended to the existing DACL; setup grants it and the
watcher ensures it at start through the new agent operation `platform.watchAccess.ensure` (no arguments: only
this DC's own watch account). Tombstones hold no secrets (passwords and other secret attributes are removed on
deletion). Verified in the lab: before, a deleted platform object produced no DirSync entry for the watch
account; after, the tombstone arrives with `isDeleted` and `lastKnownParent`. Alternative: periodic full
reconciles instead of deletion events (slower, and every handler would have to diff against its last output).
If you approve, I'll add a short amendment to ADR-0004 and ADR-0012.
