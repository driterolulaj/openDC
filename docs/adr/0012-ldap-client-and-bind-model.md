# ADR-0012: `ldapts` and the directory bind model

Status: Accepted 2026-10-24 · Date: 2026-10-06 · Decided by the project owner (Q4) · Amended 2026-10-24: account naming (Q18)

## Context
The API needs an identity to bind to the directory with. `ldapts` supports simple and a few SASL binds but
not GSSAPI, so Kerberos-authenticated LDAP from Node would need a native addon. Binding as the logged-in user
would mean keeping their plaintext password in session memory for the whole session. Managing protected
(tier-0) objects such as Domain Admins needs domain-admin-level rights.

## Decision
1. **Client:** `ldapts` over LDAPS (636) or StartTLS (389), with full certificate verification against the
   domain CA. In-house modules add:
   - paged results (built into `ldapts`)
   - DirSync control encoder/decoder
   - Show Deleted and SD Flags controls
   - a `<GUID=...>`/`<SID=...>` base-DN helper
   - **filter/DN escaping helpers (RFC 4515 / RFC 4514) with exhaustive unit tests**
2. **Two tiers of directory access:**
   - **Tier 1, delegated service account** `opendc-svc-<host>`, one per writable DC, so access can be traced and
     revoked per node. It gets AD delegations (ACEs) for create/modify/delete of users, groups, computers, OUs
     and contacts, password reset, and full control of `CN=OpenDC,CN=System`. **It is not a member of any
     protected group** and AdminSDHolder doesn't cover it, so it can't modify protected accounts. The API binds
     with it through a systemd credential (`LoadCredential=`). OpenDC RBAC (§6.10) is enforced **in the API**
     before any write.
   - **Tier 0 via the agent on a writable DC:** operations on protected objects (`adminCount=1` accounts,
     privileged groups) and on the domain itself (FSMO, functional level, demotion, sites topology, schema,
     GPO links on domain/DC OUs) are agent operations. The agent uses the DC's local privileges (`samba-tool`
     / ldb against the local `sam.ldb`). The API calls them only after checking a tier-0 permission, and for
     high-impact operations only after a typed confirmation.
   - **Watcher identity:** `opendc-watch-<host>` with read access plus "Replicating Directory Changes" (for
     DirSync), and no write rights.
   - **RODC:** the API on an RODC has a read-only account whose password is in the RODC's password replication
     policy. Writes are proxied over mTLS to a writable DC's API, which re-checks RBAC.
3. **Account naming (Q18).** `sAMAccountName` is limited to 20 characters, so each service account has two names:
   - the CN and `displayName` are readable: `opendc-svc-<host>`, `opendc-watch-<host>`, `opendc-ro-<host>`,
     `opendc-app-<appId>-<instance>`
   - `sAMAccountName` is short: `odcs-<host>`, `odcw-<host>`, `odcr-<host>`. Host names are NetBIOS names of at
     most 15 characters (enforced by pre-flight), so these fit.
   - App accounts use `odca-<appId cut to 10>-<4 hex of SHA-256(appId/instance)>`, which is also at most 20
     characters.
   - Logs and the audit trail show the readable name together with the objectGUID.
4. **Password rotation:** service account passwords are random (32 bytes, base64), rotated every 30 days by the
   leader through the agent, and redistributed to the owning node only.

## Consequences
- An API compromise (as long as the agent socket isn't abused) reaches tier-1 objects, not Domain Admins.
- AD-native tools (RSAT) don't see OpenDC's OU-scoped roles unless we also translate roles into ACEs. Phase 2
  keeps RBAC enforcement in the API only; mapping roles to native ACEs is listed as a later option.
- Some operations take two hops (API to agent). That's acceptable for rare tier-0 actions.

## Alternatives
- **Bind as the user:** needs the stored plaintext password or GSSAPI (a native addon). Rejected.
- **A single Domain Admin service account:** simplest, but turns any API bug into domain takeover. Rejected.
