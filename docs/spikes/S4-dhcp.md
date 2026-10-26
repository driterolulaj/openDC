# Spike S4: Kea on the target distributions; DNS registration of DHCP clients

Date: 2026-10-26 · ROADMAP Phase 3 ("optional DNS registration (GSS-TSIG or lease hook, per spike)"), Q6f ·
Lab: member1 (Debian 13), client1 (Ubuntu 24.04)

## Results

| | Debian 13 | Ubuntu 24.04 |
|---|---|---|
| Kea (`kea-dhcp4-server`, `-dhcp6-`, `-dhcp-ddns-`, `-ctrl-agent`, `-admin`) | 2.6.3 | 2.4.1 |
| Hooks in `kea-common` | bootp, flex_option, **ha**, **lease_cmds**, mysql_cb, perfmon, pgsql_cb, **run_script**, stat_cmds | the same without perfmon |
| GSS-TSIG hook (`libddns_gss_tsig`) | **not packaged** | **not packaged** |

## Consequences

- **Configuration:** OpenDC renders `kea-dhcp4.conf` from the directory, checks it with `kea-dhcp4 -t` before it
  replaces the running file, and applies it with the control socket's `config-reload` (no restart). A failed
  reload restores the previous file.
- **Leases:** `lease_cmds` (`lease4-get-all`) over the control socket.
- **HA:** the `ha` hook, with the 2.4+ multi-threaded HA listener (no `kea-ctrl-agent` needed).
- **DNS registration (Q6f):** Kea's D2 can't do GSS-TSIG against Samba's secure zones without the hook, so the
  decision is the **OpenDC lease hook**: `run_script` calls OpenDC on lease events, and OpenDC registers or
  removes the client's A/PTR records with `nsupdate -g` as the DHCP server's machine account (Kerberos). Optional
  per subnet; built after the core DHCP work. **Superseded, see below and Q25.**

## Found while building it (2026-10-26)

- **AppArmor:** Debian 13 confines `kea-dhcp4` with a profile that grants no `dac_override`/`dac_read_search`
  capability and no exec rights. `/etc/kea` is `_kea:_kea 0750`, so `kea-dhcp4 -t` fails as root ("Unable to
  open file") and has to run as `_kea`. The profile only reads `/etc/kea/**`, so the configuration check's
  candidate file and the HA TLS files live there (`/etc/kea/opendc-tls`). Without exec rights, the
  `run_script` lease hook can't start OpenDC: Q25 proposes reconciling DNS from the leases instead.
- **HA:** an HA pair runs only over mutual TLS with node certificates. The API refuses a pair whose servers lack
  a valid node certificate (members get theirs with node enrolment, Phase 4), and the agent and renderer refuse
  plain HTTP. Lab: dc1 (Debian 13, Kea 2.6.3) primary and dc2 (Ubuntu 24.04, Kea 2.4.1) standby reached
  `hot-standby`. A client on the reserved MAC got its address from dc1, and the lease appeared on dc2 through
  HA lease updates.
- **DHCPv6:** `kea-dhcp6` beside `kea-dhcp4`, each running only while the node serves subnets of its family; the
  same check, swap and `config-reload` path, HA on its own port (8001). Direct clients are matched by the
  subnet's `interface`. Lab: `fd97:10::/64` on the dc1/dc2 pair, both daemons reached `hot-standby`. A busybox
  `udhcpc6` client on member1 with DUID-LL `00:03:00:01:02:00:00:00:97:06` got its reserved `fd97:10::206` from
  dc1, and the lease appeared on dc2. The very first attempt, seconds after the reload, got no answer; the next
  one did (Solicit → Advertise → Request → Reply), probably while the bridge relearned Kea's multicast group.
