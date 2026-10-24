# ADR-0003: Platform objects live in the directory, no schema extension for the MVP

Status: Proposed · Date: 2026-10-06 · Amended 2026-10-24 with the Spike S1 results (approved by the project owner)

## Context
Policies, DHCP scopes, share and printer definitions, app registrations, portal configuration, RBAC roles
and the node registry must be visible on every DC and survive the loss of any one node. The directory already
replicates and is backed up. AD schema extensions can't be undone, they need the schema master, and some
client organisations' security teams reject them outright.

## Decision
1. All platform objects live under `CN=MyUCS,CN=System,<domainDN>` in one sub-container per kind (full layout
   in `docs/design/directory-object-model.md`).
2. **No schema extension for the MVP.** Platform objects use the generic class `msDS-App-Configuration`, which
   provides `msDS-Settings` (multi-valued string), `msDS-ObjectReference` (linked DN), `msDS-Integer`,
   `msDS-DateTime` and `msDS-ByteArray`. The payload is versioned JSON in `msDS-Settings`
   (`{"schemaVersion":1,...}`).
   - **Verification gate (Phase 1 spike, passed 2026-10-24, see Verification below):** confirm that this class and its attributes exist and are writable
     on every supported Samba version and base schema (`2008_R2`, `2012_R2`, `2016`), and measure size limits.
     If the spike fails, the fallback is `container` + `serviceConnectionPoint`
     (`serviceBindingInformation`, `keywords`), which has been in the schema since Windows 2000.
3. References to other directory objects are stored as **objectGUIDs** in the JSON. GUIDs stay valid when
   the target is renamed or moved, which gives rename safety. Reads resolve them with `<GUID=...>` base
   searches. Where reverse lookup is needed often, we also write `msDS-ObjectReference` to get the linked
   back-link `msDS-ObjectReferenceBL`.
4. Extended attributes on users, groups and computers use the 20 single-valued
   `msDS-cloudExtensionAttribute1..20` attributes (Windows Server 2012 schema). An admin-defined
   extended-attribute definition maps a field to one slot. Before a slot is assigned, its existing use in the
   domain is checked, because migrated Windows domains may already use some of them (for example for Entra
   Connect).
5. Granularity: one directory object per independently edited thing (one DHCP reservation, one portal tile,
   one policy). AD resolves conflicting concurrent writes per attribute (last writer wins), so small objects
   keep conflicts rare. The API uses optimistic concurrency: a `rev` field in the payload, written as an LDAP
   modify that deletes the old value and adds the new one in the same operation. On one DC this fails if
   someone else changed it first. Races across DCs during replication remain last-writer-wins, and that is
   documented.
6. A schema extension is designed **only** if we need more than 20 extended fields, multi-valued or indexed
   custom fields, or something with no generic carrier. The reserved design is in
   `docs/design/directory-object-model.md` §5. **It is not applied without the project owner's explicit approval.**

## Verification (Spike S1, 2026-10-24)
The gate in point 2 passed. Details are in `docs/spikes/S1-app-configuration.md`.
- Confirmed on Samba 4.17.12, 4.19.5, 4.22.6 and 4.22.11 with base schemas 2008_R2 through 2019. The
  fallback carrier is not needed.
- All carrier attributes are multi-valued. `msDS-Settings` and `msDS-ByteArray` have `rangeUpper` 1,000,000
  per value, and Samba enforces it (LDAP 21).
- Payloads are capped at 1,000,000 characters including the `myucs:v1:` prefix. The directory layer rejects
  larger ones with a `PlatformError`, and the soft limit is 256 KiB.
- Readers tolerate more than one `msDS-Settings` value: the highest `rev` wins and a diagnostic is raised.
- CAS conflicts (point 5) surface as LDAP 16 `noSuchAttribute`, which the API maps to HTTP 409.
- Natural-key objects (`CN=Settings`, `CN=Modules`, `CN=Branding`, leader claims) are created once and then
  only modified, never deleted and re-created, because re-adding a DN before the deletion has replicated fails.
- Extended attributes (point 4) require base schema 2012 or later. New domains default to 2019.

## Consequences
- Platform configuration replicates, is backed up by `samba-tool domain backup` and works on any DC.
- JSON in a string attribute can't be queried server-side by field, so filtering happens in the API. Object
  counts are small (hundreds to low thousands) apart from DHCP reservations, which have one object each and
  use `displayName`/`description` for searchable names.
- Older domains provisioned with the 2008_R2 schema don't have `msDS-cloudExtensionAttribute*`. Extended
  attributes are disabled there with a clear message (raise the schema by running Samba's schema upgrade).

## Alternatives
- **Custom schema up front (UCS model):** irreversible, adds friction in client security reviews, and isn't
  needed for the MVP.
- **Platform DB as the source of truth:** would need our own replication and breaks "any DC can administer".
