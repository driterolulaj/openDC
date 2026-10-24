# VM lab on Proxmox VE

A lab backend for a Proxmox VE cluster, next to the Incus backend from ADR-0015. It provides the same
topologies (`small`, `standard`, plus throwaway `spike` hosts). Nothing in it is site-specific; every
value lives in [`lab.env`](lab.env) and can be overridden with environment variables or a git-ignored
`lab.local.env`.

## Design

- **Isolated network.** An SDN VXLAN zone spans every cluster node, so VMs on different nodes share one L2
  segment (`LAB_CIDR`, default `10.97.10.0/24`). The node that runs the script is the gateway: it holds
  `LAB_GW` on the vnet and NATs to `LAB_UPLINK`. The nftables table `inet opendc_lab` drops every
  private, CGNAT and link-local destination, all IPv6, and all lab traffic to the gateway except ping.
  As a result, lab Samba DNS and Kea DHCP can't reach the site LAN, and the site LAN can't reach the lab.
- **Templates.** Official cloud images (Debian 12, Debian 13, Ubuntu 24.04) are downloaded once per node and
  verified against the published SHA-512/SHA-256 sums. Each node gets its own template, because local storage
  can't be cloned across nodes. Template id = `LAB_TPL_BASE + node index × 100 + image slot`.
- **VMs.** Lab VMs are linked clones configured with cloud-init: static IP, user `opendc`, and the gateway node's
  root key. VM id = `LAB_VMID_BASE + last IP octet`. Every lab VM carries the `opendc-lab` tag, and the script
  only ever destroys tagged VMs.
- **Secrets.** Lab domain passwords are generated on the gateway node under `/root/opendc-lab/secrets/`
  (mode 600). They never enter the repository.

## Usage (as root on the gateway node)

```sh
./pve-lab.sh net-up                      # SDN zone/vnet, gateway address, NAT + isolation rules
./pve-lab.sh up standard                 # templates (first run), clones, base packages
./pve-lab.sh domain standard             # dc-primary provisions <topology>.opendc.test, every dc joins
./pve-lab.sh snapshot standard clean     # / rollback standard clean
./pve-lab.sh ssh dc1 sudo samba-tool drs showrepl
./pve-lab.sh run s1-d13 spikes/s1-schema-matrix.sh
./pve-lab.sh down standard               # destroy that topology's VMs
./pve-lab.sh net-down                    # remove templates, SDN objects and every gateway file
```

To get the files onto the node, copy this directory to `/root/opendc-lab/src`, for example with
`scp -r test/env/proxmox root@<node>:/root/opendc-lab/src`.

## Access from the site LAN

| What | How |
|---|---|
| Logins | `./pve-lab.sh credentials` on the gateway node prints the VM user (`opendc`, with sudo) and every lab domain's Administrator password |
| VM console | Proxmox web UI → VM → Console (xterm.js; the VMs use a serial console) |
| SSH | `ssh -J root@<gateway node> opendc@<lab ip>`. Lab IPs aren't routed from the LAN, so the gateway node is the only way in. |
| Web console (from Phase 1) | `https://<gateway node>:8441` → dc1:443, `:8442` → dc2:443. Set by `LAB_PORT_FORWARDS`; re-run `net-up` after changing it. These forwards are the only inbound path into the lab. |

## Topologies

| File | VMs | Purpose |
|---|---|---|
| `topologies/small.tsv` | 1 DC, 1 client | quick checks |
| `topologies/standard.tsv` | 2 DCs (Debian 13 + Ubuntu 24.04, on different nodes), 1 member, 1 client | Phase 1/2 acceptance |
| `topologies/spike.tsv` | Debian 12, Debian 13, Ubuntu 24.04 | Spike S1 schema matrix; destroy afterwards |

`multisite` (two sites with `tc netem` latency) is not built yet. It needs a second vnet and a router VM
between the sites (Phase 4).

## Files the script creates on the gateway node

`/etc/network/interfaces.d/opendc-lab`, `/etc/sysctl.d/90-opendc-lab.conf`, `/etc/opendc-lab/nat.nft`,
`/etc/systemd/system/opendc-lab-nat.service` and the state directory `/root/opendc-lab/`.
`net-down` removes them all except the state directory.

`roles/samba-dc.sh` is lab plumbing only. In Phase 2 the product does this itself through the agent's
`samba.provision` and `samba.join` operations, and the lab then only provides the VMs.
