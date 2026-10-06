# ADR-0019: SYSVOL replication from the PDC emulator

Status: Proposed · Date: 2026-10-06 · **Fills a gap the spec doesn't mention**

## Context
Samba doesn't implement DFS-R or FRS, so SYSVOL (GPO files, logon scripts) **isn't replicated between Samba
DCs**. Without replication, GPOs behave differently depending on which DC a client asks. SYSVOL ACLs are stored
as xattrs that use Samba's local xid mapping (`idmap.ldb`), which differs between DCs unless it's kept in sync.

## Decision
1. **Source of truth:** the PDC emulator's SYSVOL. GPMC targets the PDC emulator by default, and MyUCS's GPO
   operations always run there.
2. **One-way replication** from the PDC emulator to every other DC (RODCs included):
   - Trigger: the watcher sees `versionNumber` change on `groupPolicyContainer` objects, plus a periodic run
     (default every 5 min).
   - Transport: the destination DC's agent pulls a content manifest and changed files from the source over
     node mTLS (`agent:samba.sysvol.pull`). The agent verifies the source is the current PDC emulator.
   - After applying: `samba-tool ntacl sysvolreset` on the destination (or an xattr-preserving copy when
     idmap is consistent).
3. **idmap consistency:** when a DC joins, its `idmap.ldb` is seeded from the PDC emulator
   (`agent:samba.idmap.export`/`import`), and a diagnostic compares idmap hashes across DCs.
4. A diagnostic flags SYSVOL drift (content-hash mismatch older than 2 intervals) and edits made directly on a
   non-PDC DC (detected as a destination file newer than the source; those edits are overwritten, with a warning).

## Consequences
- GPO edits made with RSAT against a non-PDC DC are lost. The docs and the console's GPO page say to target
  the PDC emulator, which is the Windows default anyway.
- This replaces the community rsync/unison recipes with a built-in, monitored mechanism.
