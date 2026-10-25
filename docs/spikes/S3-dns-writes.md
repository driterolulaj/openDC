# Spike S3: DNS record writes, agent (`samba-tool dns`) or LDAP from the API

Date: 2026-10-25 · ROADMAP Phase 3 ("spike agent vs LDAP record writes") · Lab: dc1 (Debian 13, Samba 4.22,
internal DNS), `STANDARD.OPENDC.TEST`

## Verdict

Keep the design in `docs/design/agent-operations.md` §3.4: **writes go through typed agent operations that run
`samba-tool dns … -P` (machine credentials) on the DC; reads go over LDAP from the API** with a small decoder of
the `dnsRecord` blob. No ADR change is needed.

## Results

| Check | Result |
|---|---|
| `samba-tool dns query localhost <zone> @ ALL -P` | works without a password (machine account), 73 ms |
| `samba-tool dns add/update/delete … -P` | works, 85–90 ms per call (no noticeable Python start-up cost) |
| `samba-tool dns zonecreate/zonedelete … -P` | works |
| A, AAAA, CNAME, MX (`"host pref"`), SRV (`"target port priority weight"`), TXT (`'"a" "b"'`) | all accepted as one argv element each (no shell) |
| TTL | `samba-tool dns add` has no TTL option; records get the server default (900 s) |
| Aging | `samba-tool dns zoneoptions --aging=0/1 --refreshinterval --norefreshinterval` |
| LDAP read of a zone as the delegated API account | 20 `dnsNode` objects with `dnsRecord`, 24 ms |
| LDAP create of a `dnsNode` as the delegated API account | **allowed**: AD-integrated zones let Authenticated Users create records (secure dynamic update) |

## Why the agent for writes

- Samba encodes `dnsRecord` (MS-DNSP 2.3.2.2), keeps the zone serial, and tombstones deleted records; writing
  blobs ourselves would duplicate that and drift with Samba versions.
- The agent validates each argument per record type and refuses changes to the records a DC registers for
  itself (`dns_update_list`) unless the caller holds a tier-0 permission, so a tier-1 compromise can't redirect
  `_ldap`/`_kerberos` lookups.
- The cost is small (≈ 90 ms per record) and bulk changes are rare; DHCP-driven registration (Kea DDNS) is a
  separate path (GSS-TSIG, spike in the DHCP work).

## Why LDAP for reads

- Listing a zone is one paged search; decoding A, AAAA, CNAME, NS, PTR, MX, SRV, TXT and SOA from `dnsRecord`
  is small, pure and unit-tested. Parsing `samba-tool dns query` text would be brittle.

## Diagnostics

Samba's own list of the records a DC needs (`/usr/share/samba/setup/dns_update_list`) is the reference for the
DNS diagnostics: each writable DC, its site, GUIDs and roles (PDC, GC) give the expected names; the API queries
every DC's DNS server for them. The repair is `samba_dnsupdate --verbose --all-names` on the DC concerned (agent
operation `dns.repair`).
