# Spike S2: raw results

Captured 2026-10-24 in the Proxmox lab: `packages/watcher/src/s2.lab.ts` on build1 (Node 24.22.1, ldapts 9.2.0)
against sdc1 (Debian 13, Samba 4.22.11, domain SMALL.OPENDC.TEST). Summary: [S2-dirsync.md](S2-dirsync.md).

### Spike S2: DirSync with ldapts against ldaps://10.97.10.51

| check | result |
|---|---|
| DC / dsServiceName (checkpoint binding) | sdc1.small.opendc.test / CN=NTDS Settings,CN=SDC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=small,DC=opendc,DC=test |
| highestCommittedUSN at start | 4268 |
| DirSync control advertised | yes |
| Change notification control advertised | yes |
| invocationId readable (restore detection) | 822fd692-0c26-41fe-824f-96a09105d386 |
| initial full DirSync of msDS-App-Configuration + containers | 3 entries in 1 round(s), 8 ms, cookie 108 bytes |
| DirSync with the fresh cookie, no changes | 0 entries |
| add: container + object appear in the next DirSync | 1 entries; probe attributes: cn, instanceType, isDeleted, msDS-Settings, objectGUID, uSNChanged, whenChanged |
| modify: only the changed object, with changed attributes | 1 of 1 entries; attributes: cn, instanceType, isDeleted, msDS-Settings, objectGUID, uSNChanged, whenChanged; msDS-Settings=opendc:v1:{"rev":2} |
| cookie survives a reconnect (no repeat of seen changes) | 0 entries |
| delete: tombstone delivered by DirSync | yes: isDeleted=TRUE; dn=CN=probe\0ADEL:276c53dd-1064-4565-b934-d8660dea1322,CN=Deleted Objects,DC=small, |
| fallback: (uSNChanged>=start) + Show Deleted sees the tombstone | yes (3 changed objects) |
| cleanup | ok |
| ldapts streaming (needed for change notification) | not available: search() resolves only on SearchResultDone, so a notification search never returns entries |

### Rights of a non-admin watch account (s2watch)

Without extra rights:

```
DIRSYNC-DENIED error in module dirsync: insufficient access rights during LDB_SEARCH (50) Code: 0x32
DIRSYNC-OBJECT-SECURITY-OK entries=1
```

After `samba-tool dsacl set --objectdn=DC=small,DC=opendc,DC=test --sddl="(OA;;CR;1131f6aa-9c07-11d1-f79f-00c04fc2dcd2;;<s2watch SID>)"` (DS-Replication-Get-Changes):

```
DIRSYNC-OK entries=1
DIRSYNC-OBJECT-SECURITY-OK entries=1
```
