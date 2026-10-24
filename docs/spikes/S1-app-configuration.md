# Spike S1: `msDS-App-Configuration` and `msDS-cloudExtensionAttribute*` on Samba

Date: 2026-10-24 · Gate for ADR-0003 · Raw output: [S1-raw-results.md](S1-raw-results.md)

## Verdict

**The ADR-0003 gate passes.** `msDS-App-Configuration` and its carrier attributes exist and are writable on
every Samba version and base schema we support. The `serviceConnectionPoint` fallback isn't needed. Four
findings change details of the design (see "Proposed ADR-0003 amendment" below).

## Setup

- **Schema matrix:** each base schema a Samba build offers was provisioned into a scratch `--targetdir`, then
  checked directly on `sam.ldb`.
  - Debian 12 with stock Samba 4.17.12
  - Debian 12 with bookworm-backports Samba 4.22.6
  - Debian 13 with Samba 4.22.11
  - Ubuntu 24.04 with Samba 4.19.5
- **Live:** the lab `standard` topology.
  - Domain `STANDARD.MYUCS.TEST`: dc1 runs Debian 13 / Samba 4.22.11, dc2 runs Ubuntu 24.04 / Samba 4.19.5,
    on different Proxmox nodes.
  - Each DC wrote to the other over LDAP (signed SASL bind) and read the replicated result from its local
    `sam.ldb`.
  - Both directions were run.

## Results

| Check | Result |
|---|---|
| `msDS-App-Configuration` present | **yes** on every base schema (2008_R2, 2012, 2012_R2, 2016, 2019) and every Samba build |
| Carriers `msDS-Settings`, `-ObjectReference`, `-Integer`, `-DateTime`, `-ByteArray` | present everywhere; **all multi-valued** |
| `msDS-Settings` size | `rangeUpper` **1,000,000** characters **per value**. Enforced by Samba: 1,000,001 is rejected with LDAP 21 `invalidAttributeSyntax`. A 1,000,000-character value replicates intact. |
| `msDS-ByteArray` size | `rangeUpper` 1,000,000 bytes per value |
| `msDS-cloudExtensionAttribute1..20` | **0/20 with base schema 2008_R2**, 20/20 with 2012 and later. Single-valued is enforced (a second add is rejected). Writes replicate. |
| Create/read of container + object under `CN=System` | ok everywhere |
| Linked reference | `msDS-ObjectReference` (linkID 2038) produces `msDS-ObjectReferenceBL` (2039) on the target, visible on both DCs |
| CAS (delete exact old value + add new, one modify) | current old value: applied, still exactly 1 value. Stale old value: **LDAP 16 `noSuchAttribute`**, nothing applied. |
| Replication by change notification | dc1→dc2 in 2 s, dc2→dc1 in 7 s, between Samba 4.22.11 and 4.19.5, across hypervisor nodes |
| Default for a new provision | base schema **2019** (`objectVersion` 88) on 4.19+; functional level 2008 R2 |
| Debian 12 stock Samba 4.17.12 | base schemas offered: only up to **2012_R2** (default 2012_R2). `--base-schema=2012` fails (missing schema file, packaging). No 2016/2019. |

## Consequences for the design

1. **Payload size cap.** A platform object's payload is limited to 1,000,000 characters including the
   `myucs:v1:` prefix.
   - The directory layer must reject larger payloads with a `PlatformError`, before LDAP returns error 21, and
     the message must say which object and how big it was.
   - Recommendation: a soft limit of 256 KiB per object, so replication stays cheap. The largest planned
     payloads are the portal logo (≤ 256 KB in `msDS-ByteArray`) and CRLs. A CRL above 1 MB must be split
     across multiple `msDS-ByteArray` values (the attribute is multi-valued) or published only on the file system.
2. **Readers must handle more than one `msDS-Settings` value.** The attribute is multi-valued, so "one value"
   is our convention, not a schema guarantee. Non-linked multi-valued attributes replicate as a whole
   (last writer wins), so two concurrent CAS writes on different DCs don't merge into two values. A
   manual LDAP edit can still add one. Readers take the value with the highest `rev` and raise a
   diagnostic.
3. **CAS works as designed** on one DC. LDAP 16 on the delete step is the conflict signal, and the API maps it
   to HTTP 409.
4. **Extended attributes need base schema 2012 or later.** The `cloud-extension-attributes` capability rule in
   the directory model §4 is confirmed. Every Samba build in the matrix creates new domains with 2019 by default.
5. **Base schema choice in the setup wizard (Phase 2).** Offer 2019 (the default), 2016 and 2012_R2. Don't
   offer 2008_R2 (no extended attributes) or 2012 (fails on Debian 12 stock).
6. **Debian 12 as a DC needs bookworm-backports.** Stock 4.17 can't create a 2016/2019-schema domain and is out
   of upstream support. This supports the Q10 recommendation.
7. **Natural-key objects are created once and then only modified.** In the first live run, deleting a DN on
   one DC and re-adding the same DN on the other DC a few seconds later failed. The deletion had most likely
   not replicated yet (this wasn't diagnosed further).
   - UUID-named objects are unaffected.
   - The natural-key objects (`CN=Settings`, `CN=Modules`, `CN=Branding`, leader claims
     `CN=<jobType:period>`) must be modified in place, never deleted and re-created.
   - Leader claims are only ever created by the PDC emulator, so their pruning must not race the next
     creation.

## Not covered (follow-ups)

- ACLs on the platform subtree (read restrictions for `CN=Settings` etc.): Phase 1 API skeleton work.
- LDAPS simple bind (ADR-0020). The spike used signed SASL binds from the Samba tools. LDAPS gets its own
  check in the Phase 1 login slice.
- RODC visibility of platform objects (Phase 4).
- Upgrading an existing 2008_R2-schema domain with `samba-tool domain schemaupgrade` and then enabling
  extended attributes.

## ADR-0003 amendment (approved by the project owner and applied 2026-10-24)

> **Verification (Spike S1, 2026-10-24):** confirmed on Samba 4.17.12, 4.19.5, 4.22.6 and 4.22.11 with base
> schemas 2008_R2 through 2019. All carrier attributes are multi-valued. `msDS-Settings` and `msDS-ByteArray`
> have `rangeUpper` 1,000,000 per value, enforced by Samba. Payloads are capped at 1,000,000 characters
> including the prefix (soft limit 256 KiB). Readers tolerate more than one value (highest `rev` wins and a
> diagnostic is raised). CAS conflicts surface as LDAP 16. Natural-key objects are never deleted and
> re-created. Extended attributes require base schema 2012 or later. The fallback carrier is not needed.
