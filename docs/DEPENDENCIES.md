# Dependencies

Policy (spec §4):
- built-ins first
- exact pins and a committed lockfile
- no native addons unless unavoidable
- no dependency for anything under about 100 lines
- **ask before adding anything that isn't Approved below**

"Maintenance" is checked at each yearly bump. Transitive dependency counts are measured in Phase 1 with
`npm ls --all` and recorded here.

## 1. Runtime dependencies

| Package | Status | Used by | Why | Maintenance | Replacement if abandoned |
|---|---|---|---|---|---|
| `fastify` 5 | Approved (spec) | api | HTTP server, schema hooks, logging via pino | Very active, OpenJS Foundation | `node:http` + in-house router (large) |
| `@fastify/helmet` | Approved (spec) | api | Security headers | Fastify org | ~50 lines in-house |
| `@fastify/rate-limit` | Approved (spec) | api | Login/reset/public endpoint limits | Fastify org | In-house token bucket in SQLite |
| `@fastify/cookie` | Approved (spec) | api | Signed cookies | Fastify org | ~80 lines in-house |
| `pino` | Approved (comes with Fastify) | all daemons | JSON logs to stdout → journald | Very active | `console` + JSON formatter |
| `zod` 4 | Approved (spec) | all | Schemas, types, JSON Schema/OpenAPI generation (`z.toJSONSchema`) | Very active | Valibot / TypeBox (schema rewrite) |
| `ldapts` | Approved (spec) | api, watcher | LDAP client (TLS, paged results, custom controls) | Active, single main maintainer: **bus-factor risk** | Fork and vendor. The BER layer is the hard part. |
| `nodemailer` | Approved (spec) | api | Password-reset mails, notifications | Active, zero dependencies | SMTP client in-house (~400 lines) |
| `react` 19, `react-dom` | Approved (spec) | web | UI | Meta | — |
| `@mantine/core`, `@mantine/hooks` | Approved (spec "Mantine") | web | UI kit, themes, a11y | Active | — |
| `@mantine/notifications`, `@mantine/dates`, `@mantine/form` | Approved (Q8) | web | Toasts, date pickers (expiry), forms. Same project as core. | Active | Hand-rolled equivalents |
| `@tanstack/react-query` | Approved (spec) | web | Server state, pagination | Very active | — |
| `react-router` | Approved (spec) | web | Routing, lazy routes | Active (Shopify/Remix) | — |
| `i18next` | Approved (spec) | web, api (error messages) | i18n | Active | — |
| `react-i18next` | Approved (Q8) | web | React binding for i18next (hooks, Suspense) | Same org | ~100 lines in-house binding |
| `yaml` | Approved (Q8; Phase 4) | cli, api | Deployment profiles are YAML (spec §6.16). A safe YAML 1.2 parser is far above 100 lines. Zero dependencies. | Active (eemeli) | `js-yaml`; or switch profiles to JSON |
| `better-sqlite3` | Fallback only, **needs approval if used** | api, watcher | Only if `node:sqlite` proves unusable | Active, **native addon** | `node:sqlite` |

## 2. Development and build dependencies

| Package | Status | Why |
|---|---|---|
| `typescript` | Approved (spec) | Compiler |
| `@types/node`, `@types/react`, `@types/react-dom` | Approved (Q8, implied) | Types |
| `vite`, `@vitejs/plugin-react` | Approved (spec "Vite") / plugin approved (Q8) | Web build. The plugin is needed for React Fast Refresh/JSX. |
| `vitest`, `jsdom` (or `happy-dom`) | Vitest approved / DOM env approved (Q8) | Frontend unit tests need a DOM |
| `@testing-library/react` | Approved (Q8, optional) | Component tests. We could test hooks/pure logic only and skip it. |
| `@playwright/test` | Approved (spec) | E2E |
| `@axe-core/playwright` | Approved (Q8) | WCAG 2.1 AA automated checks |
| `eslint`, `@eslint/js` | Approved (spec) | Lint |
| `typescript-eslint` | Approved (Q8, implied) | TS lint rules incl. `no-floating-promises` |
| `eslint-plugin-react-hooks` | Approved (Q8) | Hooks correctness |
| `prettier` | Approved (spec) | Formatting |
| `postcss`, `postcss-preset-mantine` | Approved (Q8) | Recommended by Mantine for its CSS modules/mixins. Could run without it, with fewer theming helpers. |
| `@cyclonedx/cyclonedx-npm` | Approved (Q8; Phase 1 CI) | SBOM per release |

## 3. Vendored binaries (shipped in our packages, pinned and checksum-verified)

| Binary | Why | Status |
|---|---|---|
| Node.js 24 LTS (official linux-x64/arm64) | ADR-0010 | Approved (Q8) |
| `nfpm` | Build-time only, packaging | Approved (spec) |
| `lego` | ACME client (ADR-0021) | **Pending decision** |

## 4. Orchestrated system components (distro packages or our image; never bundled into npm)

| Component | Role | Min version (proposal, to verify) | Notes |
|---|---|---|---|
| Samba (AD DC) | Directory, KDC, DNS, SMB | See OPEN-QUESTIONS Q10 | Heimdal builds natively on Debian/Ubuntu, our container image elsewhere |
| krb5 / Heimdal clients | `kinit`, `klist` for diagnostics | distro | |
| Kea DHCP | DHCPv4/v6 | 2.2 (Debian 12) | Config is rendered for the oldest supported Kea; control through the Unix socket |
| BIND 9 (optional) | DLZ backend | distro | |
| CUPS | Printing | distro | |
| nfs-utils / nfs-kernel-server | NFS exports | distro | |
| openssl CLI | CA operations | 3.0 | |
| Podman / Docker | Apps, Samba container mode | Podman ≥ 4.4 (quadlet) / Docker ≥ 24 | |
| chrony | Time, MS-SNTP signing on DCs | distro | |
| sssd / realmd / adcli, winbind | Linux member join | distro | |
| nginx | Front proxy (ADR-0021) | distro | **Pending decision**, not in spec §4 |
| rsync, openssh-client | Backup transfer, SYSVOL fallback | distro | |
| systemd | Units, credentials (`LoadCredential=`), socket activation | ≥ 247 | Debian 12 ships 252 |

## 5. Explicitly rejected

| Package | Reason |
|---|---|
| `fastify-type-provider-zod`, `@fastify/swagger` | Replaced by ~260 lines in-house (ADR-0011) |
| `@fastify/session`, `@fastify/csrf-protection` | In-house on `@fastify/cookie` + `node:crypto` (SECURITY §4) |
| `otplib`/`speakeasy` | TOTP is ~60 lines with `node:crypto` |
| `csv-parse` | RFC 4180 parser ~120 lines in-house |
| `prom-client` | Text exposition format in-house |
| `handlebars`/`ejs` | Templates are TS functions (ADR-0005) |
| `pm2`, Nx/Turborepo/Lerna, Babel | Spec |
| `ldapjs` | Decommissioned upstream |
