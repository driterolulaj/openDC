# Open questions for the project owner

**B** = blocks Phase 1. **L** = needed later (phase noted). Each question has a recommendation.

## A. Naming, legal, identifiers

**Q1 (B) — Product name.** "MyUCS" is a working name taken from the folder. "UCS" is Univention's product
name and likely a trademark, so for a product sold through integrators I recommend a distinct name before
Phase 1. The lowercase id (`myucs`) ends up in package names, system users, paths and the directory
container `CN=<Name>,CN=System`. **The directory container name is effectively permanent once client
domains exist.**

**Q2 (L, before any schema work) — IANA Private Enterprise Number.** Free, takes days to weeks. I recommend
requesting one now even though no schema extension is planned, so the OID arc is ready.

**Q12 (B) — Project license.** This affects:
- distribution of the Samba container image (GPLv3, so we must publish corresponding source)
- which dependencies are acceptable
- whether the fleet console can be closed source

Options: AGPL-3.0 (like UCS), Apache-2.0/MIT, or proprietary with an open core.

## B. Decisions where I propose deviating from or adding to the spec

**Q3 (B) — Schema.** Approve "**no schema extension for the MVP**" (ADR-0003):
- platform objects use `msDS-App-Configuration`
- extended attributes use the 20 `msDS-cloudExtensionAttribute*` slots
- the reserved extension design in `design/directory-object-model.md` §5 is for later review only

**Q4 (B) — Directory bind model** (ADR-0012). Approve:
- a delegated, non-tier-0 service account per writable DC
- tier-0 operations through the agent on a DC

The alternative (a single Domain Admin service account) is simpler but much riskier.

**Q5 (B) — Console login** (ADR-0020). Approve LDAPS simple bind against a TLS-verified DC instead of
"Kerberos-verified credentials". A verified TLS channel already prevents the KDC spoofing that Kerberos
verification guards against, and we avoid a native GSSAPI addon.

**Q6 (B) — Spec corrections.** Please confirm each:
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
  GSS-TSIG hook or a MyUCS lease hook. Decided by a spike in Phase 3.
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

**Q8 (B) — Approve the implied and new packages:**
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

**Q10 (B) — Minimum Samba version for the DC role.** Debian 12 ships Samba 4.17, which is no longer supported
upstream (Debian still backports security fixes), and newer versions are in `bookworm-backports`. Proposal:
- set the minimum to the oldest Samba still maintained upstream at each MyUCS release
- on Debian 12, require backports for the DC role
- capability-gate newer features (gMSA, FL 2016) by detected version

The alternative is to drop Debian 12 as a DC platform and keep it for members only.

## E. Development environment

**Q11 (B) — Where the VM lab runs, and where the repo lives.**
- This machine is **Windows 11**, and the project sits in a **OneDrive-synced folder**. `node_modules` and `.git`
  inside OneDrive cause sync storms and file locking. I recommend moving the repo to a non-synced path, ideally
  inside WSL2 (e.g. `~/src/myucs`).
- The lab needs **Linux with KVM** (Incus VMs, ADR-0015). Options:
  - (a) WSL2 with nested virtualisation on this machine. Works for `small`/`standard`; `multisite` (6+ VMs) may
    be tight on RAM.
  - (b) A separate Linux box or Proxmox host reachable from here.
  - (c) A cloud VM with nested virtualisation.

  Which do you have? Nightly CI also needs a self-hosted runner with KVM.

**Q13 (L) — Git hosting and CI.** GitHub Actions is assumed for push CI. Confirm, or tell me what you use
(GitLab/Gitea/...).

## F. Product details (later phases)

**Q14 (L, Phase 2):**
- default `idBase` for UIDs/GIDs (proposed 100000)
- default OU skeleton for new domains (proposed: no extra OUs beyond the AD defaults plus
  `OU=MyUCS Service Accounts` and `OU=MyUCS Shadow Groups`, with the rest coming from deployment profiles)

**Q15 (L, Phase 7) — Fleet console stack.** Same stack, separate deployable, own DB (SQLite or Postgres?). Is
the fleet console part of the open product or a separate commercial component?

**Q16 (L, Phase 4) — Backup encryption format.** `openssl enc` (AES-256-GCM via a CMS envelope) or an age-style
format implemented with `node:crypto`. I recommend a small, documented envelope on `node:crypto` so restores
don't depend on any particular openssl version.
