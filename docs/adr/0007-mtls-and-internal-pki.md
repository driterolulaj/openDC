# ADR-0007: Node mTLS and a two-tier internal CA

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
Nodes call each other for remote actions, and services need certificates (console, LDAPS, Kea HA, apps).
If the CA lived only on the first DC, losing that DC would stop certificate issuance, which conflicts with
"any DC can administer".

## Decision
1. **Root CA** is created at provisioning by `agent:ca.init` using the `openssl` CLI:
   - key: ECDSA P-256 by default, RSA-3072 optional for legacy clients
   - lifetime: 10 years, configurable
   - The key is stored in `/etc/opendc/secrets/pki/root.key` (root 0600). The admin can **export it for
     offline storage and remove it from the host** (`opendc ca root export`/`offline`).
2. **One issuing CA per writable DC**, signed by the root (default lifetime 3 years). It's created when the DC
   joins, while the root key is online, or by an admin with the offline root using a CSR round-trip. Any
   writable DC can issue and renew. RODCs never hold an issuing key.
3. **Node certificates**:
   - SAN `DNS:<fqdn>` and `URI:urn:opendc:node:<objectGUID of the computer account>`
   - lifetime: 1 year, auto-renewed at 2/3 of its life
   - Enrolment during join is authenticated by the admin credentials used for the join. Renewal is
     authenticated by the current node certificate.
4. **mTLS** on node RPC: TLS 1.3 only, client cert required. The peer GUID is checked against the node
   registry; a node marked `disabled` in the directory is refused even if its certificate is valid.
5. **CRLs** per issuer are published in the directory (`CN=PKI,CN=OpenDC,...`) and over HTTP from every DC
   (`/pki/crl/<issuer>.crl`). CRL lifetime is 7 days, refreshed daily by the leader and every issuer.
6. Public certificates and CRLs are stored in the directory so they replicate. Private keys never are.
7. Expiry monitoring: a diagnostic at 30, 14 and 7 days, plus automatic renewal for everything we issued.

## Consequences
- Issuance survives the loss of any DC (as long as one writable DC remains).
- An offline root is more secure but makes adding DCs a manual step (CSR export/import), which the UI guides.
- We depend on the `openssl` CLI's argument stability, which has been good across 1.1 and 3.x. The agent's
  ops are tested against each Tier-1 distro's openssl version.

## Alternatives
- **A single online CA on the primary DC:** a single point of failure.
- **Copying the root key to every DC:** if any DC is compromised, the PKI is compromised for good.
- **step-ca / Dogtag:** an extra service and dependency; overkill for this scope.
