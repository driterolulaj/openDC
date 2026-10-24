# Spike S2: DirSync and change notification with `ldapts` against Samba

Date: 2026-10-24 · Gate for ADR-0004 · Raw output: [S2-raw-results.md](S2-raw-results.md)

## Verdict

**DirSync works with `ldapts` and Samba**, and fits the ADR-0004 design without a native addon:
- the custom `DirSyncControl` from `packages/shared/src/ldap/controls.ts` sends the request
- `ldapts` parses the response control back into that same object, which is how the cookie comes back

**Change notification does not work with `ldapts`.** Samba advertises the control, but `ldapts` can only
return a search result after the final SearchResultDone message, and a notification search never sends one.
So the watcher polls with DirSync, which costs a few milliseconds when nothing changed. A notification
wake-up would need a small streaming reader (see the recommendation below).

## Setup

- **Client:** build1 (Debian 13, Node 24.22.1, `ldapts` 9.2.0), `packages/watcher/src/s2.lab.ts`.
- **Server:** sdc1 (Debian 13, Samba 4.22.11, `SMALL.OPENDC.TEST`), over LDAPS with the DC's CA verified.
- **Search:** DirSync over the domain NC with the filter
  `(|(objectClass=msDS-App-Configuration)(objectClass=container))`.

## Results

| Check | Result |
|---|---|
| Controls advertised in the rootDSE | DirSync and change notification both advertised |
| Checkpoint binding data | `dsServiceName` from the rootDSE; `invocationId` readable from the NTDS Settings object, so a restored DC is detectable |
| Initial full sync | 3 entries in 1 round, 8 ms, cookie 108 bytes |
| No changes since the cookie | 0 entries |
| Add | the new `msDS-App-Configuration` object appears in the next pass. Its new parent `container` did not appear, even though the filter includes containers (not investigated further; see follow-ups) |
| Modify | exactly the modified object, with the new `msDS-Settings`. Samba also returns `cn`, `objectGUID`, `instanceType`, `isDeleted`, `uSNChanged` and `whenChanged` for every changed object |
| Reconnect with a saved cookie | 0 entries: changes already seen are not repeated |
| Delete | the tombstone is delivered (`isDeleted=TRUE`, DN under `CN=Deleted Objects`), same `objectGUID` |
| Fallback | `(uSNChanged>=N)` with the Show Deleted control also returns the tombstone |
| Rights: plain domain user | DirSync refused: `insufficient access rights` (LDAP 50) |
| Rights: plain user + `LDAP_DIRSYNC_OBJECT_SECURITY` | works, but only for objects the user can read |
| Rights: user + DS-Replication-Get-Changes on the domain head | DirSync works |

## Consequences for the design

1. **Watch identity rights (ADR-0012 §2).** The watch account `odcw-<host>` needs one control access right:
   DS-Replication-Get-Changes (`1131f6aa-9c07-11d1-f79f-00c04fc2dcd2`) on the domain head. It does not need
   "Replicating Directory Changes All", which would expose secrets.
   - Phase 2 provisioning grants it with a typed agent operation, not with `samba-tool dsacl` from the API.
   - The alternative, `LDAP_DIRSYNC_OBJECT_SECURITY` without the right, works but silently skips objects the
     account can't read. Use it only for subtrees whose ACLs we control.
2. **Wake-up.** Poll DirSync every 5 s by default. That's the ADR default; a pass with no changes costs
   milliseconds. A change-notification wake-up needs a streaming LDAP reader for that one search (about 150
   lines on `ldapts`' exported `BerReader`/`BerWriter`), or a fork of `ldapts`. Decide in Phase 3 whether the
   latency gain is worth it.
3. **Checkpoints.** `{dsServiceName, invocationId, cookie}` is available exactly as ADR-0004 §3 assumes. A
   changed `invocationId` (DC restored from backup) triggers a full resync.
4. **Handlers see whole objects.** DirSync returns the changed object with a few always-present attributes,
   not a diff. That suits the "what should be" reconcilers of ADR-0004 §5: a handler re-reads what it needs.
5. **The watcher never builds filter strings.** DirSync searches use filters built with the escaping
   builders and converted with `ldaptsFilter()`, the same as the API (spike finding from Phase 1:
   `ldapts`' string parser decodes `\xx` escapes as Latin-1).

## Follow-ups (Phase 3)

- Why the new parent container wasn't returned. Possible causes: the DirSync filter semantics for
  `objectClass` on newly created objects, or a missed second change. Watchers filter on
  `msDS-App-Configuration`, so this doesn't block the design, but it must be understood before handlers rely
  on containers.
- DirSync across a second DC (dc1/dc2 in `standard`): a cookie from one DC must not be reused against another.
  ADR-0004 already prescribes a full resync there, and it gets a test.
- The size and `moreResults` paging of large initial syncs (50k users) in the load tests.

## Proposed ADR-0004 amendment (needs the project owner's approval; not applied)

> **Verification (Spike S2, 2026-10-24):** DirSync works through `ldapts` with an in-house control (Samba
> 4.22). The watch account needs DS-Replication-Get-Changes on the domain head (not "…All"). Change
> notification is advertised by Samba but `ldapts` can't stream search entries, so the watcher polls DirSync
> (default 5 s). A streaming wake-up reader is optional and decided in Phase 3. Checkpoints use
> `dsServiceName` + `invocationId` + cookie as specified.
