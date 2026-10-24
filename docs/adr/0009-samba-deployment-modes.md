# ADR-0009: Samba deployment modes — native and container

Status: Accepted 2026-10-24 · Date: 2026-10-06

## Context
- Debian and Ubuntu ship a Heimdal-based Samba AD DC that's widely used in production.
- Upstream Samba still calls the AD DC built against MIT Kerberos experimental. Fedora (and, to be verified,
  openSUSE) build it that way.
- RHEL and its rebuilds (Rocky, Alma) don't ship the AD DC role at all.

## Decision
1. **Native mode:** distro packages. This is Tier 1 for the DC role on Debian 12/13 and Ubuntu 24.04/26.04.
   It also covers member and managed-node roles everywhere.
2. **Container mode:** a OpenDC-built, pinned Samba AD DC OCI image (Heimdal build, a known Samba version),
   used for the DC role on RHEL-family distros. Opt-in for Fedora and openSUSE.
   - Runs under rootful Podman (Docker allowed) with **host networking**. Samba needs ports 53, 88, 135, 137-139,
     389, 445, 464, 636, 3268/3269 and the dynamic RPC range 49152-65535.
   - Needs `CAP_SYS_ADMIN` so it can write `security.NTACL` xattrs. The container is therefore not a security
     boundary; it's a packaging mechanism, and the docs say so.
   - State lives in host bind mounts (`/var/lib/opendc/samba/{private,sysvol,state,etc}`) on a filesystem with
     xattrs and ACLs. Pre-flight verifies this.
   - Wrapper: the OS adapter's `samba` facet exposes the same operations either way. `samba-tool` runs via
     `podman exec`. The agent never cares which mode is active.
   - The image is built in our CI from upstream Samba sources, signed, published with an SBOM, and its GPL
     corresponding source is published (licensing obligation).
3. **Mixed versions:** a domain may have native DCs on different Samba versions and container DCs on the pinned
   version. Feature capabilities are calculated as the **minimum across all writable DCs** (see the capability
   table in the directory object model).
4. **Refusal rules**, enforced by pre-flight and the support matrix:
   - DC role on RHEL-family with native Samba: refused, with a pointer to container mode.
   - DC role where the filesystem lacks xattr/ACL support: refused.
   - Container mode without Podman ≥ 4 or Docker ≥ 24: refused.
   - Native DC with a Samba version below the minimum (Q10 in OPEN-QUESTIONS): refused.

## Consequences
- Covers RHEL-family DCs without us maintaining RPM builds of Samba.
- We take on a Samba release cadence: the image needs security updates within days of Samba releases. That's
  an ongoing release-engineering commitment, and it's in the LTS support policy.
- Container mode is Tier 2 and is CI-tested nightly once Phase 6 starts.

## Alternatives
- **Building our own Samba RPMs for EL:** a heavier packaging burden and it collides with distro packages.
- **Refusing RHEL DCs entirely:** simpler, but it shuts out a large part of the market. It stays an option if
  maintaining the image proves too costly.
