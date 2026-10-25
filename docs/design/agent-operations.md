# Agent operation catalogue

Status: Phase 0 draft (ADR-0006). This is the **complete** list of what root can be asked to do. Adding an
operation means a catalogue change, review, and a security note.

## 1. Protocol

- Transport: Unix stream sockets created by `opendc-agent.socket`, one per caller:

  | Socket | Group | Caller |
  |---|---|---|
  | `/run/opendc/agent-api.sock` | `_opendc-api` | API (incl. node RPC handlers on members) |
  | `/run/opendc/agent-watch.sock` | `_opendc-watch` | watcher / registry commits |
  | `/run/opendc/agent-cli.sock` | `opendc-admin` | local CLI run by root/admins (break-glass, setup before the API exists) |

- Framing: newline-delimited JSON-RPC 2.0, max frame 4 MiB (larger payloads such as backups go by file
  reference, never inline).
- Request: `{"jsonrpc":"2.0","id":"<uuid>","method":"<op>","params":{"v":1,"args":{...},"actor":{"sid":"S-1-5-...","name":"alice","via":"api|node-rpc|watcher|cli"},"idempotencyKey":"..."}}`
- Progress notifications: `{"jsonrpc":"2.0","method":"progress","params":{"id":"<request id>","step":"...","percent":40,"line":"..."}}`
- Errors: JSON-RPC error with `data: {code, messageKey, fixKey, params}`. The codes come from `packages/shared/src/errors.ts`.
- Each operation is defined as follows (Phase 1 type in `packages/agent/src/ops/types.ts`):

```ts
interface AgentOperation<A extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  id: string;                    // "service.reload"
  version: 1;
  args: A;                       // strict Zod schema (unknown keys rejected)
  result: R;
  sockets: ('api' | 'watch' | 'cli')[];
  roles: RoleSelector[];         // refused on nodes with other roles
  risk: 'read' | 'write' | 'tier0';
  confirm?: 'typed';             // requires a confirmation token minted by the API for this exact op+args
  concurrency: 'parallel' | 'exclusive' | `lock:${string}`;
  timeoutMs: number;
  redact?: string[];             // arg paths never logged
  run(args: z.infer<A>, ctx: AgentContext): Promise<z.infer<R>>;
}
```

- **Typed confirmation tokens:** for `confirm: 'typed'` operations, the API mints a short-lived HMAC token
  over `(op, canonical args, actor, expiry)` after the user has typed the confirmation phrase. The HMAC key is
  shared between API and agent through a systemd credential. The agent verifies the token, so a compromised API
  can't silently skip the confirmation UI without also holding the key, and the key rotates on every agent
  start. It's defence in depth, not a hard boundary, because the API holds the key too.
- **Generic rules applied to every operation:** argv-only exec, absolute binaries from `OsFacts.binaries`,
  the env is reset, `umask 077`, realpath checks against `managedRoots()` for anything path-like, and
  journald logging with redaction.

## 2. Phase 1 operations (the "agent with 3 operations")

| Op | Args | Sockets | Risk | Notes |
|---|---|---|---|---|
| `system.info` | — | api, watch, cli | read | hostname, FQDN, OS release, versions, uptime |
| `service.status` | `unit: ManagedUnitId` | api, watch, cli | read | only declared units |
| `file.writeManaged` | `fileId, content (≤1 MiB), expectedPrevSha256?` | watch, cli | write | path/owner/mode from the allowlist. Atomic, keeps a backup. Returns `{changed, sha256}` |

## 3. Full catalogue

Legend for sockets: **A** = api, **W** = watch, **C** = cli. Risk: R = read, W = write, T0 = tier-0. ✔c = typed confirmation.

### 3.1 System, services, files
| Op | Args (summary) | Sock | Risk | Phase |
|---|---|---|---|---|
| `system.info` | — | AWC | R | 1 |
| `system.diskUsage` | `pathKeys[]` | AWC | R | 1 |
| `system.reboot` | `at?, reason` | AC | W ✔c | 4 |
| `system.setHostname` | `fqdn` (validated RFC 1123, ≤ 15-char NetBIOS-safe label) | C | W | 2 (setup only, refused after provisioning) |
| `service.status` | `unit` | AWC | R | 1 |
| `service.start/stop/restart/reload` | `unit` (allowed actions per manifest) | AWC | W | 1 |
| `service.enable/disable` | `unit, now` | AC | W | 2 |
| `service.failedUnits` | — | AWC | R | 4 |
| `journal.read` | `unit (managed or platform), since?, lines ≤ 5000, priority?` | AC | R | 4 |
| `file.writeManaged` | `fileId, content, expectedPrevSha256?` | WC | W | 1 |
| `file.readManaged` | `fileId` | AWC | R | 1 |
| `file.restorePrevious` | `fileId` | WC | W | 1 |
| `file.removeManaged` | `fileId` | WC | W | 3 |
| `registry.commitLock` | `acquire|release, holder` | AW | W | 1 |

### 3.2 Secrets
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `secret.generate` | `secretId (declared), kind, length?` | AC | W | 2 |
| `secret.rotate` | `secretId` | AC | W | 2 |
| `secret.importFromPeer` | `secretId, peerNodeGuid` (pulled over mTLS from a writable DC's agent; policy decides which secrets may move) | C (+node RPC) | T0 | 4 |
| `secret.delete` | `secretId` | AC | W | 2 |
| `secret.deliver` | `secretId, target: systemd-credential|podman-secret, consumer` | AC | W | 2 |

**No operation returns secret material**, except where a generated initial password is shown once
(`users.create` flows handle that in the API with a password the API itself generated, never the agent).

### 3.3 Samba / domain (native or container, same ops)
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `samba.status` | — | AWC | R | 2 |
| `samba.version` | — | AWC | R | 1 |
| `samba.testparm` | — | AC | R | 2 |
| `samba.provision` | `fqdn, hostIp, domain, netbiosDomain, adminPassword, dnsForwarders[], ntpServers[], ntpAllow[], baseSchema: 2012_R2|2016, functionalLevel, dnsBackend: SAMBA_INTERNAL, siteName, idBase` (`packages/shared/src/domain/setup.ts`) | C (+API during setup wizard via one-time setup token) | T0 ✔c | 2 |
| `samba.join` | `fqdn, hostIp, domain, dcHost, username, password, dnsForwarders[], ntpServers[], ntpAllow[], siteName` (writable DC; RODC/member in Phase 4) | C (+setup token) | T0 ✔c | 2 / 4 |
| `samba.demote` | `removeOtherDead?: dsaGuid, credentialsSecretId?` | AC | T0 ✔c | 4 |
| `samba.fsmo.show` | — | AWC | R | 2 |
| `samba.fsmo.transfer` | `roles[]` | AC | T0 ✔c | 2 |
| `samba.fsmo.seize` | `roles[]` (refuses unless the current holder is unreachable for > N min, or `force` with a second confirmation) | AC | T0 ✔c | 2 |
| `samba.level.show` | — | AWC | R | 2 |
| `samba.level.raise` | `domain?, forest?` | AC | T0 ✔c | 2 |
| `samba.drs.showrepl` | `json: true` | AWC | R | 4 |
| `samba.drs.replicate` | `sourceDsa, destDsa, nc, full?` | AC | W | 4 |
| `samba.drs.kcc` | — | AC | W | 4 |
| `samba.sites.create/remove` | `name` | AC | T0 | 4 |
| `samba.sites.subnet.create/remove/setSite` | `cidr, site` | AC | T0 | 4 |
| `samba.sites.link.set` | `link, sites[], cost, intervalMin, schedule?` | AC | T0 | 4 |
| `samba.protectedObject.modify` | `targetGuid, changes (typed: memberAdd/Remove, passwordReset, enable/disable)` | A | T0 ✔c | 2 |
| `directory.posixIds.fill` | `guids[]` (≤ 500 users or groups; per-object results); the agent computes `idBase + RID` (ADR-0018, Q22), never overwrites, refuses a used ID | A, W, C | W | 3 |
| `samba.gpo.list` | — | AWC | R | 3 |
| `samba.gpo.backup` | `gpoGuid, targetId` | AC | W | 3 |
| `samba.gpo.restore` | `backupId, newName?` | AC | T0 ✔c | 3 |
| `samba.gpo.setlink/dellink` | `gpoGuid, containerGuid, enforced?, disabled?` | AC | W (T0 for domain/DC OU) | 3 |
| `samba.gpo.create` | `displayName` | AC | W | 3 |
| `samba.dbcheck` | `fix: false` (only read mode via API; `fix: true` only via CLI) | AC (fix: C) | R / T0 | 4 |
| `samba.ntacl.sysvolreset` | — | WC | W | 4 |
| `samba.sysvol.pull` | `sourceNodeGuid` (must be the current PDC emulator) | WC | W | 4 |
| `samba.idmap.export/import` | `peerNodeGuid` | C (+node RPC) | T0 | 4 |
| `samba.backup.online` | `targetId, encryptWithKeyId` | AC | W | 4 |
| `samba.backup.offline` | `targetId, encryptWithKeyId` | AC | W | 4 |
| `samba.restore` | `backupId, newDcName, siteName` (fresh host only) | C | T0 ✔c | 4 |
| `samba.keytab.export` | `principal (allowlisted SPN pattern), keytabSecretId` | AC | T0 | 3 / 5 |
| `samba.containerImage.install` | `imageRef@digest` (from signed release metadata only) | C | T0 | 6 |
| `smb.reloadConfig` | — | WC | W | 6 |

Phase 2 notes on provisioning and join (amended 2026-10-25, for review):
- The initial Administrator password (provision) and the joining account's password (join) are passed **in the
  request**, redacted from every log, instead of the planned `adminPasswordSecretId`/`credentialsSecretId`.
  There is no operation to store a caller-supplied secret, and the passwords are needed exactly once. They
  reach Samba on stdin (an LDIF `unicodePwd` change against the local `sam.ldb`) or in the environment
  (`PASSWD` for `samba-tool domain join`), never in argv.
- One operation does the whole sequence (host name, resolver, the `samba-dc` package set, Samba units,
  provision/join, Kerberos, start, DNS check, chrony with `ntpsigndsocket`, platform objects, service accounts,
  secrets, registry and `node.json`), reporting progress per step. It's idempotent: a failed run can simply be
  repeated. `system.setHostname` and `resolver.configure` remain catalogued for later standalone use.
- Packages are installed by a transient systemd unit (`systemd-run --wait`), because dpkg must create setuid
  files and the agent's own unit has `RestrictSUIDSGID=yes`.

### 3.4 DNS (Samba internal or BIND9_DLZ)
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `dns.zone.list` | — | AWC | R | 3 |
| `dns.zone.create/delete` | `zone (validated), type: forward|reverse` | A | W (delete ✔c) | 3 |
| `dns.record.add/update/delete` | `zone, name, type ∈ {A,AAAA,CNAME,MX,SRV,TXT,PTR,NS}, data (typed per type), ttl` | AW | W | 3 |
| `dns.zone.setAging` | `zone, aging, refreshH, noRefreshH` | A | W | 3 |
| `dns.forwarders.set` | `servers[]` (renders `dns forwarder` through the registry, then restarts Samba) | — | via registry | 3 |

The DNS operations wrap `samba-tool dns` with machine credentials on the DC. Phase 3 has a spike to compare
this with writing `dnsRecord` blobs over LDAP from the API, which would avoid root; the result will be an
ADR amendment.

### 3.5 DHCP (Kea)
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `kea.configTest` | `fileId` (validates the rendered candidate before the swap) | W | R | 3 |
| `kea.command` | `daemon: dhcp4|dhcp6, command ∈ {config-reload, status-get, lease4-get-page, lease6-get-page, lease4-get, lease4-del, ha-heartbeat, ha-maintenance-start, ha-maintenance-cancel}, args (typed per command)` | AW | R/W | 3 |

Uses Kea's Unix control socket directly, which works across Kea 2.x and 3.x with or without the control agent.

### 3.6 PKI / certificates / ACME
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `ca.init` | `subject, keyType: ec-p256|rsa-3072, days` | C (+setup token) | T0 | 3 |
| `ca.issuer.create` | `forNodeGuid` (root key must be online) | AC | T0 ✔c | 3 / 4 |
| `ca.issuer.csr / ca.issuer.importSigned` | offline root flow | AC | T0 | 4 |
| `ca.root.export` | `targetId, passphraseSecretId` | C | T0 ✔c | 4 |
| `ca.root.offline` | removes the root key after verifying an export exists | C | T0 ✔c | 4 |
| `cert.issue` | `profile ∈ {node, service, web, ldaps, kea-ha, app}, csrPem or keyId, sans[] (validated against profile rules)` | AW | W | 3 |
| `cert.revoke` | `serial, reason` | A | W ✔c | 3 |
| `cert.install` | `certId, fileId(s)` | W | W | 3 |
| `crl.generate` | `issuer` | AW | W | 3 |
| `acme.register / acme.obtain / acme.renew` | `account, names[], challenge: http-01|dns-01, providerSecretId?` | AW | W | 3 |

### 3.7 Packages / updates / firewall / time / network
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `pkg.refresh` | — | AW | W | 6 |
| `pkg.listUpgrades` | — | AW | R | 6 |
| `pkg.upgradeAll` | `securityOnly` | A | W ✔c (on DCs) | 6 |
| `pkg.installSet / pkg.removeSet` | `setId` (manifest-declared) | AC | W | 2+ |
| `pkg.rebootRequired` | — | AW | R | 6 |
| `platform.configureRepo` | `channel: stable|testing` | AC | W | 6 |
| `platform.upgrade` | `targetVersion` (signed repo metadata only) | AC | T0 ✔c | 6 |
| `firewall.apply` | — (computes the union of enabled port sets) | WC | W | 2 |
| `time.configure` | via registry (chrony fileId) | W | W | 2 |
| `time.tracking` | — | AW | R | 2 |
| `resolver.configure` | `nameservers[], searchDomains[], freePort53` | C (+setup token) | W | 2 |
| `network.applyWithRollback / network.confirm` | `iface, addresses[], gateway?, dns[]`, `timeoutSec` | C (+setup token) | W ✔c | 2 |

### 3.8 Containers / App Center
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `container.pull` | `appId, image@sha256 (must match a verified catalog entry cached on disk)` | A | W | 5 |
| `container.create` | `appId, instance, spec` (spec rendered by the agent from the verified app manifest plus admin settings validated against the manifest's settings schema; no raw `capAdd`/`privileged` from the API) | A | W | 5 |
| `container.start/stop/restart` | `appId, instance` | A | W | 5 |
| `container.remove` | `appId, instance, keepData` | A | W (✔c if `keepData=false`) | 5 |
| `container.logs` | `appId, instance, since?, lines` | A | R | 5 |
| `volume.snapshot / volume.restore` | `appId, instance, snapshotId` | A | W | 5 |
| `app.catalog.verifyAndCache` | `sourceId` (fetches the catalog, verifies Ed25519 against pinned keys, caches it root-owned) | A | W | 5 |

### 3.9 File, print, storage
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `share.ensureDir` | `shareId` (path from the share definition, constrained to configured storage roots) | W | W | 6 |
| `share.setAcl` | `shareId, aclSpec (typed)` | AW | W | 6 |
| `quota.set` | `fs (storage root), user/group SID, soft, hard` | AW | W | 6 |
| `nfs.exportfsReload` | — | W | W | 6 |
| `cups.printer.upsert/delete` | `printerId` (from the directory definition: URI scheme allowlist, PPD/driver from installed set) | W | W | 6 |

### 3.10 Backup, diagnostics, support, node lifecycle
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `backup.run` | `jobId` (job spec from directory policy; components ∈ {domain, registry, ca, apps, platformDb}) | A | W | 4 |
| `backup.transfer` | `artifactId, targetId (rsync/SFTP target from definition; SSH key as secret)` | A | W | 4 |
| `backup.prune` | `targetId, retention` | A | W | 4 |
| `backup.restoreComponent` | `artifactId, component ∈ {registry, ca, apps, platformDb}` | C | T0 ✔c | 4 |
| `diag.run` | `checkId` (each check's commands are fixed in its op; e.g. `chronyc tracking`, `klist -k`, `samba-tool drs showrepl --json`) | AW | R | 4 |
| `support.bundle` | `include[] (fixed categories), redact: true (forced)` | AC | R | 7 |
| `node.enroll` | `csrKeyId, enrollmentToken` | C | W | 4 |
| `node.cert.renew` | — | W | W | 4 |
| `node.leave` | — | C | W ✔c | 4 |
| `realm.joinLinux` | `realm, dcHost, credentialsSecretId, mode: sssd|winbind` (managed nodes) | C | W | 4 |
| `fleet.connect / fleet.disconnect` | `fleetUrl, enrollmentToken` | AC | W ✔c | 7 |

### 3.11 Setup (added in Phase 2)
| Op | Args | Sock | Risk | Phase |
|---|---|---|---|---|
| `setup.status` | — (with the setup token on the api socket, reports whether it is valid) | AC | R | 2 |
| `setup.preflight` | `role: primary-dc|dc, fqdn, hostIp, domain, netbiosDomain?, dnsForwarders[], dcHost?` | C (+setup token) | R | 2 |

## 4. Allowlist generation
`npm run gen` intersects each module's `agentOperations` (with `from` sockets) with the catalogue above and
writes `packages/agent/src/generated/allowlist.ts`:

```ts
export const allowlist = {
  api:   new Set(['system.info', 'service.status', /* ... */]),
  watch: new Set(['file.writeManaged', 'service.reload', /* ... */]),
  cli:   new Set([/* ... */]),
  files: { 'dhcp.kea-dhcp4': { pathKey: 'kea.dhcp4.conf', owner: 'root', mode: 0o640, comment: 'json-field' } /* ... */ },
  units: { 'kea-dhcp4': ['reload', 'restart', 'status'] /* ... */ },
  packageSets: { /* ... */ },
} as const;
```

The agent refuses to start if the generated allowlist references an operation it doesn't implement.

## 5. Setup token
Before the domain exists there are no users or RBAC. `opendc setup` (the CLI as root) or the first-boot wizard
uses a **one-time setup token** printed to the console and journal at install time
(`/etc/opendc/secrets/setup-token`, 0600). The wizard must present it. It unlocks the setup-only operations
marked "+setup token", and it's destroyed once provisioning or join completes.

Implementation (Phase 2): `opendc-agent --init-secrets` creates the token while `/etc/opendc/node.json` doesn't
exist (25 characters from an alphabet without look-alikes, about 116 bits). The package's post-install script
prints it; `sudo opendc setup token` shows it again. Catalogue entries flagged `setup: true` are compiled into
the allowlist's `setup` list: the agent accepts them on the api socket only when the request carries a token
that matches the file (SHA-256 compared in constant time; case, blanks and dashes ignored). The API never sees
the file; it forwards the `X-Setup-Token` header.
