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
  per subnet; built after the core DHCP work.
