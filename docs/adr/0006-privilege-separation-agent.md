# ADR-0006: Privilege separation with a typed root agent

Status: Proposed · Date: 2026-10-06

## Context
The platform has to restart services, write system config, run `samba-tool`, manage packages and containers.
A web-facing process that runs as root turns any bug into full compromise of the host, and on a DC full
compromise of the host means full compromise of the domain.

## Decision
1. `myucs-api` runs as `_myucs-api` and `myucs-watcher` as `_myucs-watch`, both unprivileged with hardened
   systemd units. `myucs-agent` runs as root and has **no network listener**.
2. Transport: systemd socket activation with **one socket per caller**:
   - `/run/myucs/agent-api.sock` (group `_myucs-api`, mode 0660)
   - `/run/myucs/agent-watch.sock` (group `_myucs-watch`, mode 0660)
   - `/run/myucs/agent-cli.sock` (group `myucs-admin`; for local root/admin CLI use)

   Each socket has **its own allowlist subset**. We use filesystem permissions instead of `SO_PEERCRED`, which
   Node can't read without a native addon.
3. Protocol: newline-delimited JSON-RPC 2.0. Each request has `{op, version, args, requestId, actor?, idempotencyKey?}`.
   - Arguments are validated against the operation's Zod schema; unknown fields are rejected.
   - Long operations stream progress notifications, which are relayed to jobs/SSE.
4. **Operations are narrow and typed.** The catalogue is in `docs/design/agent-operations.md`. Specifically:
   - **No generic `samba.tool(args[])`.** That is effectively domain admin plus arbitrary file writes (for
     example `--targetdir`). Each needed `samba-tool` subcommand becomes its own operation with validated
     arguments, and the agent builds the argv itself.
   - `file.writeManaged(fileId, content)` takes a **fileId** from the compiled allowlist, never a path.
   - `service.*` accepts only units the manifests declare as managed.
   - Package operations install only manifest-declared package sets or apply OS updates. There is no
     arbitrary package name.
   - Secrets are referenced by `secretId`. Operations can create or rotate a secret and hand it to a consumer
     (a systemd credential or Podman secret) but **never return it** over the socket. The one exception is
     generated one-time initial passwords, which are explicitly flagged and never logged.
5. Execution: `execFile`/`spawn` with argv arrays, `shell: false`, a fixed environment
   (`PATH` from the OS adapter, `LANG=C.UTF-8`), timeouts, and output size limits. Binaries are resolved to
   absolute paths by the OS adapter.
6. The allowlist is generated at build time from module manifests (ADR-0022) and shipped read-only in
   `/usr/lib/myucs`. The agent loads no code or allowlist data from writable locations.
7. Every operation is logged to journald with requestId, actor, op and argument summary (secrets redacted by
   schema annotations).

## Consequences
- An API compromise gives an attacker the allowlist, not root. On a DC the allowlist is still very powerful
  (tier-0 directory operations), so RBAC, typed confirmations and the audit log matter (SECURITY.md).
- Every new root capability needs a catalogue entry and review, which is deliberate friction.
- The agent is written in TypeScript and uses the same Zod schemas, so there's no separate language to maintain.

## Alternatives
- **sudo rules for the API user:** coarse, and argument validation in sudoers is fragile.
- **polkit:** distro differences, and it doesn't give typed arguments.
- **An agent in Go/Rust:** a second toolchain. Worth reconsidering only if the agent's attack surface grows.
