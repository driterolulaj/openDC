# ADR-0002: Samba AD is the only directory technology

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
UCS runs OpenLDAP as its main directory and Samba AD alongside it, joined by the S4 connector. That gives two
sources of truth, sync conflicts, a large maintenance burden, and AD features (PSOs, sites, native
replication) that never map cleanly onto OpenLDAP. Windows, macOS and Linux clients all speak AD natively.

## Decision
1. Samba 4 AD DC is the only directory, KDC and default DNS server. OpenDC reaches it over LDAPS (or StartTLS)
   with a verified certificate. Simple binds without TLS are refused on the DC
   (`ldap server require strong auth = yes`, set explicitly even though it's the default).
2. Multi-DC replication uses Samba's native multi-master DRS. OpenDC adds no replication of its own for
   directory data. (SYSVOL is a separate problem, see ADR-0019.)
3. **AD sites and subnets** are modelled from the beginning: the profile schema has them in Phase 2 and they
   are managed from Phase 4. Inter-site replication schedules use site links.
4. **Any writable DC** serves the console and the full API. The only operations tied to a particular DC are
   FSMO-bound ones (schema master, domain naming, RID master, PDC emulator, infrastructure) and platform
   singleton jobs (ADR-0017). The UI says which DC is needed and whether it's reachable.
5. One forest and one domain per client installation. Multi-domain forests and external trusts are later
   work. To keep them possible: never assume a single domain naming context, always derive DNs from
   `rootDSE` (`defaultNamingContext`, `configurationNamingContext`, `schemaNamingContext`), and store
   object references as GUIDs/SIDs, not as bare `sAMAccountName`s.

## Consequences
- No sync connector, so no sync conflicts. The directory data model is AD's, which Windows admins already know.
- We inherit Samba's limits (RODC, SYSVOL, version spread). They're listed in ARCHITECTURE §9 and handled
  explicitly.
- Platform data has to fit AD's schema and replication model (ADR-0003).
- Losing every writable DC stops administration. Losing any one does not.

## Alternatives
- **OpenLDAP + Samba with a connector (UCS model):** rejected for the reasons above.
- **389-DS / FreeIPA:** not AD-compatible enough for Windows clients and GPOs.
