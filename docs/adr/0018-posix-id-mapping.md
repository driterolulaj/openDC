# ADR-0018: POSIX IDs from the RID (RFC2307 attributes)

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
Linux members, NFS and file shares need the same UID/GID for a user on every host. Counter-based allocation in
a multi-master directory can produce duplicates when two DCs allocate at the same time.

## Decision
- New domains are provisioned with `--use-rfc2307`. On creation, OpenDC writes `uidNumber`/`gidNumber` as
  **`idBase + RID`** (default `idBase = 100000`, configurable per installation at provisioning time). The RID
  is unique domain-wide by construction (the RID master hands out pools), so there's no counter and no race.
- Users get `loginShell`, `unixHomeDirectory` and `gidNumber` (primary group, default "Domain Users")
  from the user template.
- For migrated or joined domains, existing `uidNumber`/`gidNumber` values are kept. New objects use RID-based
  values, and pre-flight checks that the range is free.
- Linux members read these attributes: sssd with `ldap_id_mapping = false`, or winbind with `idmap_ad`. The
  join scripts render the matching config.
- Admins can override a value by hand; uniqueness is checked through a directory search before saving.

## Consequences
- Deterministic, conflict-free, and stable across rename and move.
- RIDs can be large (up to 2^30), so `idBase + RID` stays well within 32-bit UIDs.
