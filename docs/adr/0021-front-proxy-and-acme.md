# ADR-0021: Front proxy (nginx) and ACME client (lego)

Status: Accepted 2026-10-26 · Date: 2026-10-06 · Decided by the project owner (Q7)

## Context
- The console, the portal and every App Center app (Keycloak, Nextcloud, ...) need HTTPS on 443, reached by
  path or by hostname.
- Apps are containers with their own ports.
- Public names need ACME, and the spec asks for an external client binary chosen in an ADR.
- Building a reverse proxy into Node would mean a new dependency (`@fastify/http-proxy`) and making ourselves
  responsible for HTTP edge security.

## Decision (proposed)
1. **nginx from distro packages** as the front proxy on every node that serves the console or apps.
   - It's in every supported distro and is security-patched by the distro.
   - Config is rendered by the Config Registry (fileId `proxy.sites`), and app manifests contribute
     locations/vhosts.
   - It terminates TLS with certificates from the internal CA or ACME, sets HSTS, and forwards to `opendc-api`
     on a Unix socket, so the API needs no `CAP_NET_BIND_SERVICE`.
2. **lego** as the ACME client: a single static Go binary, MIT licence, HTTP-01 and DNS-01 with many DNS
   providers. It's vendored and pinned per release because it isn't packaged on every distro. It's driven by
   `agent:acme.*` operations, with credentials as agent secrets.

## Alternatives
- **Caddy:** proxy and ACME in one binary. Simpler, but less familiar to ops teams and not packaged
  everywhere (we'd vendor it too).
- **Apache (UCS uses it):** heavier, and the module set varies by distro.
- **certbot:** a Python dependency tree on every node.
- **acme.sh:** shell, which makes argument-safety review hard.

## Consequences
nginx becomes an orchestrated system component (added to §4's external tools). lego becomes a vendored binary
with a security-update obligation.
