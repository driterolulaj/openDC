# Directory object model

Status: Phase 0 draft (ADR-0003). **No schema extension is proposed for application.** §5 documents a
reserved design for the project owner to review in case one becomes necessary later.

## 1. Standard AD objects MyUCS manages

| Thing | objectClass | Key attributes MyUCS reads/writes | Notes |
|---|---|---|---|
| User | `user` | `sAMAccountName`, `userPrincipalName`, `givenName`, `sn`, `displayName`, `mail`, `telephoneNumber`, `title`, `department`, `manager`, `description`, `userAccountControl`, `accountExpires`, `lockoutTime` (reset to 0 for unlock), `pwdLastSet`, `unicodePwd` (write only, over TLS), `thumbnailPhoto` (≤ 100 KB, JPEG), `uidNumber`, `gidNumber`, `loginShell`, `unixHomeDirectory`, `homeDirectory`, `homeDrive`, `profilePath`, `scriptPath`, `msDS-cloudExtensionAttribute1..20` | Read-only/computed: `objectGUID`, `objectSid`, `tokenGroups` (transitive group SIDs, used by RBAC), `msDS-User-Account-Control-Computed`, `msDS-ResultantPSO`, `adminCount`, `whenCreated`, `whenChanged`, `badPwdCount`, `lastLogonTimestamp` |
| Group | `group` | `sAMAccountName`, `groupType` (security/distribution × global/domain-local/universal), `member`, `description`, `mail`, `gidNumber`, `managedBy` | Nested membership through `member`. `memberOf` is read-only. |
| Computer | `computer` | `dNSHostName`, `operatingSystem*`, `servicePrincipalName` (read), `description`, `location`, `managedBy`, `msDS-SupportedEncryptionTypes` | Node objects reference the computer GUID. |
| OU / container | `organizationalUnit`, `container` | `ou`, `description`, `gPLink` (via `samba.gpo.*` only), `gPOptions` | Platform policies are linked by GUID reference from the policy (§3), so `gPLink` is left to GPOs. |
| Contact | `contact` | name and mail attributes | |
| PSO | `msDS-PasswordSettings` in `CN=Password Settings Container,CN=System` | `msDS-PasswordSettingsPrecedence`, `msDS-MinimumPasswordLength`, ..., `msDS-PSOAppliesTo` | Applies to users and groups only (see §3.2). |
| gMSA | `msDS-GroupManagedServiceAccount` | | Capability-gated (`gmsa`) by the Samba version on all DCs. |
| Site / subnet / site link | `site`, `subnet`, `siteLink` in the configuration NC | `siteObject`, `cost`, `replInterval`, `schedule` | Changed through `samba.sites.*` operations (tier 0). |
| GPO | `groupPolicyContainer` | read: `displayName`, `versionNumber`, `gPCFileSysPath`, `flags` | Contents are edited with RSAT; links and backups through the agent. |
| DNS | `dnsZone`, `dnsNode` in `DC=DomainDnsZones` / `DC=ForestDnsZones` | | Through `dns.*` operations (Phase 3 spike decides between agent and LDAP). |
| Service accounts (platform) | `user` | `myucs-svc-<host>`, `myucs-watch-<host>`, `myucs-ro-<host>` (RODC), app accounts `app-<appId>-<instance>` | Live in `OU=MyUCS Service Accounts,<domainDN>`, configurable. |

## 2. Platform container layout

All objects below are `msDS-App-Configuration` unless they're plain `container`s. **Verification gate:** the
Phase 1 spike confirms the class and attributes on Samba with base schemas 2008_R2, 2012_R2 and 2016. If it
fails, the fallback carrier is `serviceConnectionPoint` (ADR-0003).

```
CN=MyUCS,CN=System,<domainDN>                       container
├─ CN=Settings                                       msDS-App-Configuration  domain-wide platform settings
├─ CN=Nodes                                          container
│   └─ CN=<computer objectGUID>                      node registration
├─ CN=Modules                                        msDS-App-Configuration  enabled/disabled modules, versions
├─ CN=RBAC                                           container
│   ├─ CN=Roles / CN=<role uuid>                     role definition
│   └─ CN=Assignments / CN=<uuid>                    role assignment (principals × scopes)
├─ CN=Policies                                       container
│   └─ CN=<policy uuid>                              policy (all types)
├─ CN=UserTemplates / CN=<uuid>
├─ CN=ExtendedAttributes / CN=<uuid>                 extended attribute definitions (slot mappings)
├─ CN=SavedSearches / CN=<uuid>                      shared saved filters (personal ones too, owned)
├─ CN=DHCP
│   ├─ CN=Services / CN=<uuid>                       Kea service instance (node GUIDs, HA pair)
│   ├─ CN=Subnets / CN=<uuid>                        subnet + pools + options
│   └─ CN=Reservations / CN=<uuid>                   one per host reservation
├─ CN=Shares / CN=<uuid>
├─ CN=NFSExports / CN=<uuid>
├─ CN=Printers / CN=<uuid>   , CN=PrinterGroups / CN=<uuid>
├─ CN=PKI
│   ├─ CN=Issuers / CN=<issuer id>                   public cert, CRL (msDS-ByteArray), node GUID
│   └─ CN=Certificates / CN=<serial>                 issued-cert index (public metadata only)
├─ CN=Apps
│   ├─ CN=Catalogs / CN=<uuid>                       catalog source URL + pinned public keys
│   └─ CN=Instances / CN=<appId>-<instance>          installed app instance (node GUID, settings, version)
├─ CN=Portal
│   ├─ CN=Branding                                   logo (msDS-ByteArray ≤ 256 KB), colors, texts
│   ├─ CN=Categories / CN=<uuid>
│   └─ CN=Tiles / CN=<uuid>
├─ CN=Backup / CN=Targets|Jobs / CN=<uuid>           target definitions (secrets referenced, never stored)
├─ CN=Jobs / CN=Claims / CN=<jobType:period>         leader idempotency claims (ADR-0017), auto-pruned
└─ CN=Fleet                                          fleet enrolment metadata (Phase 7)
```

ACLs: the whole subtree is writable by `myucs-svc-*` (via a group `MyUCS Platform Services`) and Domain
Admins, readable by authenticated users **except** `CN=Settings`, `CN=RBAC`, `CN=Backup`, `CN=Fleet`, which only
platform services and Domain Admins can read.

## 3. Payloads

Every `msDS-App-Configuration` platform object has:

| Attribute | Use |
|---|---|
| `cn` | UUID (or a natural key where noted). Never renamed. |
| `displayName` | human name (searchable) |
| `description` | optional free text |
| `msDS-Settings` | **one value**: `myucs:v1:` + canonical JSON payload. The prefix lets us detect foreign values and future framing changes. |
| `msDS-ObjectReference` | optional linked references (used by policies → OUs, to get back-links) |
| `msDS-ByteArray` | binary blobs (logo, CRL) where needed |

Common payload envelope (Zod in `packages/shared/src/directory/`):

```ts
interface PayloadEnvelope<K extends string, T> {
  schemaVersion: number;      // per kind; readers ignore unknown fields; never downgrade-write
  kind: K;                    // "policy", "dhcp.subnet", ...
  rev: number;                // optimistic concurrency (CAS via delete-old/add-new on the value)
  updatedBy: { sid: string; name: string; nodeGuid: string };
  updatedAt: string;          // ISO-8601
  data: T;
}
```

### 3.1 Policy
```ts
interface PolicyData {
  type: 'password' | 'dhcp' | 'desktop' | 'share-defaults' | 'update-schedule' | 'registry';
  priority: number;                       // tie-break among policies linked at the same OU level
  links: { targetGuid: string; enforced: boolean; enabled: boolean }[]; // OUs, containers or the domain head
  filter?: { groupGuids?: string[]; nodeRoles?: NodeRole[] };          // optional targeting
  settings: Record<string, unknown>;      // validated by the policy type's Zod schema
}
```
**Effective policy resolution** (pure function, unit-tested):
1. Walk from the object's container up to the domain head.
2. At each level, collect enabled links. Closer links win over more distant ones, **except** that `enforced`
   links from higher levels win over everything below them, as GPO enforcement does.
3. Within a level, lower `priority` wins.
4. Merging is per setting key: each key takes the value from the winning policy that defines it. The viewer
   shows, for each key, the source policy and the OU it came from.

### 3.2 Password policy implementation (deviation from a literal "link to OU")
AD PSOs can't be linked to OUs. For a `password` policy, MyUCS:
- creates or updates a PSO `MyUCS-<policy uuid>` with the policy's settings, mapping precedence to the policy's
  position (closer OU = lower precedence number, so it wins);
- maintains a shadow security group `pso-<policy uuid>` in `OU=MyUCS Shadow Groups`, applies the PSO to it, and
  has the leader keep its membership equal to "users whose effective password policy is this one" (recomputed
  on user create/move and on policy or link changes);
- links at the domain head edit the **Default Domain Policy** password settings instead.

### 3.3 Other payloads (summary; full Zod in Phase 2–6)

| Kind | Data (summary) |
|---|---|
| `node` | `role`, `site`, `osRelease`, `platformVersion`, `sambaVersion`, `capabilities[]`, `lastSeen` (written ≤ every 15 min to limit replication churn; live health comes over node RPC), `disabled` |
| `settings` | `idBase`, `defaultUserContainerGuid`, `serviceAccountOuGuid`, `branding` reference, `passwordReset` options, `telemetry: false`, `apiDeprecations` |
| `rbac.role` | `name`, `permissions[]`, `tier0: boolean`, `builtin: boolean` |
| `rbac.assignment` | `roleId`, `principals: {sid, guid}[]` (users or groups; resolved through `tokenGroups`), `scopes: {targetGuid, subtree: true}[]` (OUs; or `domain`) |
| `userTemplate` | `containerGuid`, `defaults` (attribute → value with `{firstname}`-style placeholders), `groups[]`, `unix` defaults, `extended` defaults |
| `extendedAttribute` | `name`, `label` (i18n map), `appliesTo: user|group|computer`, `slot: 1..20` (cloud extension attr), `type: string|enum|bool|date|int` (stored as string), `validation`, `formTab`, `selfServiceEditable` |
| `dhcp.subnet` | `cidr`, `pools[]`, `options` (typed Kea options), `serviceGuid`, `ddns` |
| `dhcp.reservation` | `subnetGuid`, `hw` (MAC) or `clientId`, `ip`, `hostname`, `options` |
| `share` | `nodeGuid`, `name`, `pathKey` under a storage root, `acl` (SID-based), `quotaDefaults`, `smbOptions` (allowlisted), `homeShare: boolean` |
| `printer` | `nodeGuid`, `name`, `uri`, `driver`, `location`, `publishSmb`, `allowedGroupSids` |
| `app.instance` | `appId`, `version`, `channel`, `nodeGuid`, `settings` (validated by the app manifest schema), `serviceAccountGuid`, `oidcClientId`, `portalTileIds[]` |
| `portal.tile` | `title` (i18n map), `url`, `iconRef`, `categoryId`, `visibleToGroupSids[]`, `order`, `openIn: tab|same` |
| `backup.job` | `components[]`, `schedule`, `targetId`, `retention`, `encryptionKeyId` |

## 4. Capability table (computed, cached in `CN=Settings`)

| Capability | Requirement (to be verified per Samba version in the Phase 1 spike) |
|---|---|
| `cloud-extension-attributes` | 2012 or later schema present (`msDS-cloudExtensionAttribute1` exists in the schema NC) |
| `rfc2307` | `uidNumber` etc. in schema (always present; domain provisioned with `--use-rfc2307` or NIS domain object present) |
| `fl-2016` | all writable DCs run a Samba version that supports FL 2016 **and** an admin has raised the level |
| `gmsa` | all writable DCs ≥ the minimum Samba version for gMSA, FL ≥ 2012, KDS root key present |
| `rodc` | always technically available; flagged "limited" in the UI |

Capabilities are recomputed by the leader when a DC joins or upgrades, and checked again just before any
operation that needs them.

## 5. Reserved schema extension (NOT applied — design for review only)

Only needed if more than 20 extended attributes, multi-valued or indexed custom fields, or an object kind with
no generic carrier are required. **Applying it requires the project owner's explicit approval** and a
registered IANA PEN (OPEN-QUESTIONS Q2).

OID arc (placeholder): `1.3.6.1.4.1.<PEN>.1` = MyUCS
- `.1.1` attributes, `.1.2` classes, `.1.3` syntaxes (unused)

| Name | OID | Syntax | Single | Indexed | Purpose |
|---|---|---|---|---|---|
| `myucsExtString` | `.1.1.1` | Unicode string (2.5.5.12), rangeUpper 1024 | no | yes (`searchFlags=1`) | multi-valued `key=value` custom fields (searchable by `key=value*`) |
| `myucsExtData` | `.1.1.2` | Unicode string, rangeUpper 65536 | yes | no | versioned JSON for non-searchable custom data |
| `myucsObjectKind` | `.1.1.3` | Unicode string, 64 | yes | yes | server-side filtering of platform objects |
| `myucsExtensible` (aux class) | `.1.2.1` | — | — | — | `mayContain: myucsExtString, myucsExtData`; auxiliary to `user`, `group`, `computer`, `organizationalUnit` |

Rules if it's ever applied: done once, during a maintenance window, by the schema master's agent
(`samba.schema.apply`, a new tier-0 op that isn't in the catalogue yet), after a forced online backup. The
LDIF is committed under `packaging/schema/` and reviewed. Nothing is ever deleted (attributes can only be
deactivated).
