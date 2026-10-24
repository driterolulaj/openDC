# Security model and threat model

Status: updated after Phase 1 (2026-10-24, see §12). **Updated at the end of every phase.**

## 1. Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| Domain directory and KDC secrets | Domain compromise = compromise of every joined machine | Samba `sam.ldb`, `secrets.ldb` on every DC |
| `krbtgt` and machine keys | Golden or silver tickets | Samba DB |
| Platform service-account credentials | Tier-1 directory write | `/etc/opendc/secrets/` on writable DCs |
| CA root and issuing keys | Can impersonate any node or service; mTLS trust | `/etc/opendc/secrets/pki/` (root can go offline) |
| Agent socket access | Root-level actions within the allowlist | `/run/opendc/agent-*.sock` |
| Console sessions | Admin rights | Platform DB (session id hashes), cookies |
| Audit log | Accountability, compliance | Platform DB on DCs (replicated) |
| Backups | Contain every domain secret | Local staging + remote targets (encrypted) |
| App Center catalog keys | Supply chain for software running on client hosts | Pinned public keys in the directory; private keys with the publisher |
| Fleet console link | Cross-client blast radius | Fleet server; client-side opt-in config |

## 2. Actors

- Anonymous network attacker on the LAN or the internet (portal and password reset may be exposed).
- Authenticated end user (portal, self-service).
- Delegated admin (Helpdesk) trying to go beyond their scope, e.g. resetting a Domain Admin's password.
- Compromised member server or managed node.
- Compromised app container.
- Malicious or compromised catalog source or package mirror.
- Integrator or fleet operator with too much reach.
- Insider with physical or console access to a DC (out of scope for prevention, in scope for audit).

## 3. Trust boundaries and threats (STRIDE)

| # | Boundary | Main threats | Mitigations |
|---|---|---|---|
| B1 | Browser ↔ proxy/API | Session theft, CSRF, XSS, brute force, injection | TLS 1.2+/HSTS; HttpOnly/Secure/SameSite=Strict cookies; CSRF (§4); strict CSP (no inline scripts), React escaping; rate limits and domain lockout; Zod on every route; LDAP escaping helpers |
| B2 | API ↔ agent | API compromise escalates to root | Separate users; per-caller sockets; narrow typed operations; no generic exec; fileIds not paths; typed confirmation tokens for tier-0; journald audit of every operation |
| B3 | API/watcher ↔ Samba | Credential capture, MITM, over-privilege | LDAPS with CA verification; delegated non-tier-0 service account (ADR-0012); tier-0 via the agent only; `ldap server require strong auth = yes` |
| B4 | Node ↔ node | Rogue node, MITM, lateral movement from a member | mTLS 1.3 with cert↔computer GUID binding; members accept operations only from writable DCs; disabled flag checked live; CRLs; secrets moved only DC→DC and only per policy |
| B5 | Catalog/package source ↔ host | Malicious app or update | Ed25519-signed catalogs with pinned keys; images pulled by digest only; signed apt/rpm repos; agent re-verifies (doesn't trust the API's word) |
| B6 | App container ↔ host/domain | Container escape, directory abuse | Rootless Podman where possible; no `privileged`/`capAdd` from admin input; per-app service account with least privilege (bind/read only, scoped); secrets through Podman secrets; per-app network |
| B7 | Client ↔ fleet console | Cross-tenant leak, remote takeover | Outbound-only, opt-in, revocable; metadata only (schema-allowlisted payload, no directory data); no write without an explicit grant; per-client certs; the fleet console can't initiate connections |
| B8 | Public endpoints (reset, registration) | Account enumeration, mail bombing, token theft | Same response whether or not the account exists; per-IP and per-account limits; tokens: 32 random bytes, stored as SHA-256, single use, 30 min expiry, bound to the account's `pwdLastSet`; CAPTCHA hook optional |
| B9 | Integrator support bundle | PII or secret leakage | Opt-in; redaction by schema (secret fields) plus pattern scrubbing (keys, passwords, tokens, mail addresses optionally); preview before export |

## 4. Authentication and session design

- **Login:** LDAPS simple bind against a verified DC (ADR-0020). The password is discarded right after the bind.
- **Session:** a 256-bit random id. The cookie is `__Host-opendc_sid` (Secure, HttpOnly, SameSite=Strict, Path=/).
  The DB stores SHA-256(id), user SID/GUID, the `tokenGroups` snapshot, created, last seen and IP.
  Idle timeout 30 min, absolute 12 h, both configurable. Group changes take effect at the next snapshot
  refresh (every 5 min) or right away for the affected user.
- **CSRF:** SameSite=Strict, plus a synchronizer token: a per-session random value returned by `/api/v1/session`
  that must be echoed in `X-CSRF-Token` on every state-changing request, plus an `Origin` header check.
- **TOTP:** RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step), implemented with `node:crypto`. The seed is encrypted
  with AES-256-GCM using a key delivered as a systemd credential. Recovery codes are stored hashed.
- **Re-authentication** is required for tier-0 operations within the last 5 minutes (password + TOTP).
- **API tokens** for the CLI and automation: scoped to roles, with expiry, stored hashed, shown once.
- **Self-service password change:** LDAP password change with old and new value (`unicodePwd` delete/add) over
  TLS, so the domain policy is enforced by Samba and errors are mapped to policy feedback.

## 5. Authorization

- Permissions are checked on the server in a Fastify `preHandler` for every route, using the route's declared
  permission. No route can register without declaring one (enforced at startup).
- Scope check: the target object's DN must fall within an assigned scope subtree. DNs are normalised
  (RFC 4514 parsing, case-folded attribute types and values per AD rules) before comparing suffixes. Moves need
  the permission on both the source and the target scope.
- **Tier-0 guard:** objects with `adminCount=1` or membership in protected groups need a tier-0 permission,
  whatever the OU scope. This blocks the classic "helpdesk resets a Domain Admin's password" path.
- The UI mirrors permissions through `/api/v1/session/permissions`, for display only.

## 6. Hardened systemd units (baseline)

`opendc-api.service` / `opendc-watcher.service`:
```
User=_opendc-api            # resp. _opendc-watch
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=no   # V8 JIT needs W^X exceptions; documented
SystemCallArchitectures=native
SystemCallFilter=@system-service
CapabilityBoundingSet=      # empty; the API listens on a Unix socket behind nginx (ADR-0021)
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/opendc/api /run/opendc
LoadCredential=ldap-bind:/etc/opendc/secrets/svc-ldap
LoadCredential=csrf-hmac:/etc/opendc/secrets/api-hmac
UMask=0077
```
`opendc-agent.service` runs as root (it has to), but still with `ProtectHome=read-only`, `PrivateTmp`,
`ProtectKernelModules`, `RestrictRealtime`, `LockPersonality`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`
(INET only for node-RPC pulls such as SYSVOL and secrets) and `SystemCallArchitectures=native`.
`ProtectSystem` can't be strict, because it writes into `/etc` and `/var/lib/samba`. Each OS adapter supplies a
`ReadWritePaths=` list as narrow as possible.

## 7. Input handling rules

- Zod `.strict()` at every boundary. Lengths bounded and Unicode normalised (NFC) for names.
- LDAP: `escapeFilterValue()` (RFC 4515: `\ * ( ) NUL` plus non-ASCII as `\xx`) and `escapeDnValue()`
  (RFC 4514), with property-based and table tests. No string-built filters outside the helper module
  (lint rule).
- Exec: argv arrays only, `shell:false`. A lint rule bans `exec`, `execSync`, `shell: true` and
  `child_process` imports outside `packages/agent` and `packages/os`.
- Paths: allowlisted fileIds, realpath plus prefix check against `managedRoots()`, `O_NOFOLLOW` on the final
  component, no writes into directories other users can write to.
- Uploads (CSV, LDIF, photos, logos, profiles): size limits, content sniffing, CSV formula injection
  neutralised on export (`= + - @` prefixes).

## 8. Secrets inventory

| Secret | Location | Rotation | Exposure |
|---|---|---|---|
| Service-account passwords | `/etc/opendc/secrets/svc-*` | 30 days (leader) | systemd credential to the owning service only |
| CA root key | `/etc/opendc/secrets/pki/root.key` or offline | 10 years | agent only |
| Issuing CA keys | `/etc/opendc/secrets/pki/issuer.key` per DC | 3 years | agent only |
| Node TLS key | `/etc/opendc/secrets/node.key` | yearly | api (credential) |
| Session/CSRF/confirm HMAC keys | `/etc/opendc/secrets/api-hmac` | agent start / 24 h | api + agent |
| TOTP encryption key | `/etc/opendc/secrets/totp.key` | manual (re-encrypt job) | api credential |
| Backup encryption key | `/etc/opendc/secrets/backup.key` + printed recovery copy | manual | agent only |
| App secrets | `/etc/opendc/secrets/apps/<app>/<name>` | per app manifest | Podman secret |
| Setup token | `/etc/opendc/secrets/setup-token` | one-time | console output at install |

Backups are encrypted (AES-256-GCM via `openssl`, or age-style envelope; the decision comes in Phase 4).
Restore documentation stresses that the backup key must be stored off-host.

## 9. Supply chain

- Lockfile committed; `npm ci --ignore-scripts`; no install scripts allowed (native fallback excepted, if approved).
- Exact pins; an automated weekly advisory scan (`npm audit` in CI, which reports and doesn't block on dev-only
  issues); yearly planned bump.
- Releases: reproducible build from tag, SBOM, signed packages and repo metadata, signed Samba container image.
- The App Center trusts only catalog keys pinned in the directory; adding a source needs a tier-0 permission.

## 10. Known residual risks (accepted, documented)

1. Root on any writable DC equals domain compromise. That's inherent to AD.
2. An attacker who controls the API process can call any operation on the API socket's allowlist, including
   tier-0 operations if they can mint confirmation tokens (the HMAC key is shared). Mitigations: audit trail,
   journald, typed operations. Separating the token key from the API would need a second process; that's
   revisited in Phase 8 hardening.
3. Multi-master races: platform payload edits on two DCs at once resolve last-writer-wins after replication
   (ADR-0003).
4. Samba RODC limitations may cache more secrets than a Windows RODC would. The UI documents the password
   replication policy.
5. Container mode needs `CAP_SYS_ADMIN`, so the container isn't a security boundary.

## 11. Vulnerability disclosure
Until the project has a public mail domain (Q19), security reports go to the local address `security@localhost`
on the OpenDC development host. The OpenDC mail module (Phase 5) will provide the mail server. Policy text is
due in Phase 8.

## 12. Status after Phase 1 (2026-10-24)

### Implemented and tested
| Control | Where | Evidence |
|---|---|---|
| Root actions only through typed agent operations, per-socket allowlists compiled at build time | `packages/agent`, `packages/agent/src/generated/allowlist.ts` | Agent tests reject unknown ops, ops on the wrong socket, extra args, path traversal, unmanaged files and units. The agent refuses to start if the allowlist names an unimplemented op. |
| No shell strings | ESLint `opendc/no-shell-exec`; `packages/os/src/exec.ts` | `execFile` with argv, `shell: false`, fixed env, timeouts, output caps |
| LDAP injection | `packages/shared/src/ldap`, ESLint `opendc/no-raw-ldap` | RFC 4515/4514 escaping with property tests. Filters reach `ldapts` as filter objects built by our own byte-exact parser, because `ldapts`' string parser decodes `\xx` escapes as Latin-1. |
| Login (ADR-0020) | `packages/api/src/directory.ts` | LDAPS to a CA-verified DC (the local Samba CA, copied by `opendc-secrets-init`). Empty passwords are refused before any traffic (AD treats them as an anonymous bind). AD bind sub-codes map to distinct errors. Failover on network errors only. |
| Sessions and CSRF (§4) | `packages/api/src/sessions.ts`, `http/route.ts` | Session ids stored as SHA-256; `__Host-` cookie, Secure, HttpOnly, SameSite=Strict. CSRF token = HMAC(session id), so nothing is stored. Every write, including login, must come from the same origin. |
| Authorization (§5) | `packages/api/src/rbac` | Routes can't register without a permission (startup check). Tier-0 permissions only in tier-0 roles. Tier-0 guard for protected targets. OU scopes compared on normalised DNs. Denials are audited. |
| Audit log (ADR-0013) | `packages/api/src/audit.ts` | Triggers reject UPDATE and DELETE. The per-origin hash chain detects edits made after the triggers are dropped (tested). Secret-looking fields are redacted. |
| Hardened units (§6) | `packaging/systemd` | `systemd-analyze security` exposure 1.3 for `opendc-api` and `opendc-watcher` on Debian 13 and Ubuntu 24.04 (limit 3.0) |
| Secrets (§8) | `opendc-agent --init-secrets`, `LoadCredential=` | HMAC key, console key and LDAP CA live in `/etc/opendc/secrets` (0700/0600) and reach services only as credentials. None are in the platform DB, logs, API responses or the agent journal (file contents are never logged). |
| Supply chain (§9) | `.npmrc`, `packaging/build.ts` | Exact pins, `ignore-scripts`, lockfile. The bundled Node 24.22.1 and nfpm are pinned by SHA-256. Packages ship production dependencies only. CI actions are pinned by commit SHA. |

### Known gaps (accepted for Phase 1, each with the phase that closes it)
1. **Group changes during a session.** The `tokenGroups` snapshot from login isn't refreshed yet, because that
   needs the delegated service account (Phase 2). Until then a removed group membership takes effect at the
   next login, at the latest after the 12 h absolute session lifetime.
2. **Self-signed console certificate** until the internal CA exists (Phase 3). The API serves HTTPS itself on
   port 8443 until the front-proxy decision (Q7, ADR-0021).
3. **One HMAC key** serves both CSRF and the typed confirmations (`api-hmac`). That is residual risk §10.2 as
   designed; no Phase 1 operation requires a confirmation.
4. **No TOTP second factor yet** (Phase 2). The Domain Admin role should require it from Phase 2 on (ADR-0020).
5. **Node role.** The agent reads it from `/etc/opendc/node.json`, which the Phase 2 setup writes; until then
   every node reports `managed-node`. No Phase 1 operation is role-restricted.
6. **Rate limits are per process** and reset when the API restarts. The domain lockout policy still applies to
   every failed bind.
7. **Packages are not signed yet.** Signing comes with release engineering (Phase 7). Build inputs are
   checksum-verified.
8. **Non-DC nodes** trust the system CA store for LDAPS until the domain CA is distributed (Phase 3).
