#!/usr/bin/env bash
# OpenDC VM lab on a Proxmox VE cluster (the primary lab backend, ADR-0015; see README.md).
#
# Runs as root on the cluster node that acts as the lab gateway. Every cross-node action goes through
# pvesh, so one node drives the whole cluster. The script only ever touches:
#   - the SDN zone/vnet named in lab.env
#   - VMs carrying the lab tag, and the lab templates
#   - three files on the gateway node: /etc/network/interfaces.d/opendc-lab, /etc/sysctl.d/90-opendc-lab.conf,
#     /etc/opendc-lab/ (+ the opendc-lab-nat.service unit)
#
# Usage: pve-lab.sh net-up | net-down | templates [--refresh] | up <topology> | domain <topology>
#        | down <topology> | snapshot <topology> <name> | rollback <topology> <name> | status | credentials
#        | ssh <vm-name> [cmd...] | run <vm-name> <script> [VAR=value...]
#        | install-pkgs <vm-name> <dir> | acceptance <topology> <dir>
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$LAB_DIR/lab.local.env" ]] && source "$LAB_DIR/lab.local.env"
# shellcheck source=lab.env
source "$LAB_DIR/lab.env"

STATE_DIR=/root/opendc-lab
KNOWN_HOSTS="$STATE_DIR/known_hosts"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o ConnectTimeout=5 -o LogLevel=ERROR)

log() { printf '[lab] %s\n' "$*" >&2; }
die() { printf '[lab] ERROR: %s\n' "$*" >&2; exit 1; }

json() { perl -MJSON::PP -0777 -ne "my \$d = decode_json(\$_); $1"; }

# "<name> <ip>" per cluster node, sorted by name; the index in this list is the topology "node" column.
cluster_nodes() {
  pvesh get /cluster/status --output-format json |
    json 'print map { "$_->{name} $_->{ip}\n" } sort { $a->{name} cmp $b->{name} } grep { $_->{type} eq "node" } @$d'
}
node_by_index() { cluster_nodes | sed -n "$(($1 + 1))p" | cut -d' ' -f1; }
node_count() { cluster_nodes | wc -l; }

# "<vmid> <node> <status> <tags> <name>" for every VM in the cluster
cluster_vms() {
  pvesh get /cluster/resources --type vm --output-format json |
    json 'print map { "$_->{vmid} $_->{node} $_->{status} " . ($_->{tags} // "-") . " $_->{name}\n" } grep { $_->{type} eq "qemu" } @$d'
}
vm_line() { cluster_vms | awk -v id="$1" '$1 == id'; }

urlencode() { perl -pe 's/([^A-Za-z0-9._~-])/sprintf("%%%02X", ord($1))/ge'; }

# ---------------------------------------------------------------- images
# image -> "slot url checksum-file algorithm"
image_info() {
  case "$1" in
    debian-12) echo "12 https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2 SHA512SUMS sha512" ;;
    debian-13) echo "13 https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2 SHA512SUMS sha512" ;;
    ubuntu-2404) echo "24 https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img SHA256SUMS sha256" ;;
    *) die "Unknown image '$1'; add it to image_info() in pve-lab.sh" ;;
  esac
}
ALL_IMAGES=(debian-12 debian-13 ubuntu-2404)

template_id() { # <image> <node-index>
  local slot; read -r slot _ <<<"$(image_info "$1")"
  echo $((LAB_TPL_BASE + $2 * 100 + slot))
}

ensure_image() { # <image> <node>  -> downloads into the import storage, verified by the published checksum
  local image="$1" node="$2" slot url sums algo file sum
  read -r slot url sums algo <<<"$(image_info "$image")"
  file="opendc-$image.qcow2"
  if pvesh get "/nodes/$node/storage/$LAB_IMPORT_STORAGE/content" --content import --output-format json |
    json 'print map { "$_->{volid}\n" } @$d' | grep -qx "$LAB_IMPORT_STORAGE:import/$file"; then
    return 0
  fi
  sum="$(curl -fsSL "${url%/*}/$sums" | awk -v f="${url##*/}" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 }')"
  [[ -n "$sum" ]] || die "No checksum for ${url##*/} in ${url%/*}/$sums"
  log "downloading $image to $node:$LAB_IMPORT_STORAGE ($algo verified)"
  pvesh create "/nodes/$node/storage/$LAB_IMPORT_STORAGE/download-url" --content import \
    --filename "$file" --url "$url" --checksum "$sum" --checksum-algorithm "$algo" >/dev/null
}

cmd_templates() {
  local refresh=0 idx node image id
  [[ "${1:-}" == "--refresh" ]] && refresh=1
  for ((idx = 0; idx < $(node_count); idx++)); do
    node="$(node_by_index "$idx")"
    for image in "${ALL_IMAGES[@]}"; do
      id="$(template_id "$image" "$idx")"
      if [[ -n "$(vm_line "$id")" ]]; then
        ((refresh)) || continue
        log "removing template $id for refresh (fails if linked clones still exist)"
        pvesh delete "/nodes/$node/qemu/$id" --purge 1 >/dev/null
        pvesh delete "/nodes/$node/storage/$LAB_IMPORT_STORAGE/content/$LAB_IMPORT_STORAGE:import/opendc-$image.qcow2" >/dev/null
      fi
      ensure_image "$image" "$node"
      log "creating template $id (tpl-$image) on $node"
      # cloud-init drive on virtio-scsi: Debian 12's cloud kernel has no AHCI driver for an IDE/SATA cdrom on q35
      pvesh create "/nodes/$node/qemu" --vmid "$id" --name "tpl-$image" --tags "$LAB_TAG;template" \
        --ostype l26 --machine q35 --cpu host --cores 2 --memory 2048 --agent enabled=1 \
        --scsihw virtio-scsi-single \
        --scsi0 "$LAB_STORAGE:0,import-from=$LAB_IMPORT_STORAGE:import/opendc-$image.qcow2,discard=on,iothread=1,ssd=1" \
        --scsi1 "$LAB_STORAGE:cloudinit" --boot order=scsi0 --serial0 socket --vga serial0 \
        --net0 "virtio,bridge=$LAB_VNET,mtu=1" >/dev/null
      pvesh create "/nodes/$node/qemu/$id/template" >/dev/null
    done
  done
}

# ---------------------------------------------------------------- network
cmd_net_up() {
  local peers
  peers="$(cluster_nodes | awk '{ print $2 }' | paste -sd,)"
  if ! pvesh get "/cluster/sdn/zones/$LAB_ZONE" >/dev/null 2>&1; then
    log "creating SDN VXLAN zone $LAB_ZONE (peers $peers)"
    pvesh create /cluster/sdn/zones --zone "$LAB_ZONE" --type vxlan --peers "$peers" --mtu "$LAB_MTU" >/dev/null
  fi
  if ! pvesh get "/cluster/sdn/vnets/$LAB_VNET" >/dev/null 2>&1; then
    log "creating SDN vnet $LAB_VNET (VNI $LAB_VXLAN_TAG)"
    pvesh create /cluster/sdn/vnets --vnet "$LAB_VNET" --zone "$LAB_ZONE" --tag "$LAB_VXLAN_TAG" --alias "OpenDC lab" >/dev/null
  fi
  log "applying SDN configuration"
  pvesh set /cluster/sdn >/dev/null
  for _ in $(seq 30); do ip link show "$LAB_VNET" >/dev/null 2>&1 && break; sleep 1; done
  ip link show "$LAB_VNET" >/dev/null 2>&1 || die "vnet bridge $LAB_VNET did not appear; check 'pvesh get /cluster/sdn/zones'"

  log "configuring gateway $LAB_GW on $(hostname) with NAT to $LAB_UPLINK"
  cat >/etc/network/interfaces.d/opendc-lab <<EOF
# Managed by OpenDC test/env/proxmox/pve-lab.sh: lab gateway address on the SDN vnet.
# Removed by 'pve-lab.sh net-down'.
iface $LAB_VNET
	address $LAB_GW/$LAB_PREFIX
EOF
  echo "net.ipv4.ip_forward = 1  # OpenDC lab gateway (pve-lab.sh)" >/etc/sysctl.d/90-opendc-lab.conf
  sysctl -q -p /etc/sysctl.d/90-opendc-lab.conf
  mkdir -p /etc/opendc-lab
  local dnat="" fwd hport fip fport
  for fwd in $LAB_PORT_FORWARDS; do
    IFS=: read -r hport fip fport <<<"$fwd"
    dnat+="    iifname \"$LAB_UPLINK\" fib daddr type local tcp dport $hport dnat ip to $fip:$fport"$'\n'
  done
  cat >/etc/opendc-lab/nat.nft <<EOF
# Managed by OpenDC test/env/proxmox/pve-lab.sh
# The lab reaches the internet only. Private, CGNAT and link-local destinations are dropped so lab DNS/DHCP
# services can never talk to the site LAN, and the gateway node accepts nothing from the lab but ping.
# The only inbound path is the explicit port forwards in the prerouting chain (LAB_PORT_FORWARDS).
table inet opendc_lab
flush table inet opendc_lab
table inet opendc_lab {
  set blocked4 {
    type ipv4_addr; flags interval
    elements = { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 }
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "$LAB_VNET" ct state established,related accept
    iifname "$LAB_VNET" icmp type echo-request accept
    iifname "$LAB_VNET" drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    ct status dnat accept
    ip saddr $LAB_CIDR ip daddr $LAB_CIDR accept
    iifname "$LAB_VNET" ip daddr @blocked4 drop
    iifname "$LAB_VNET" meta nfproto ipv6 drop
    iifname "$LAB_VNET" oifname "$LAB_UPLINK" accept
    oifname "$LAB_VNET" ct state established,related accept
    oifname "$LAB_VNET" drop
  }
  chain prerouting {
    type nat hook prerouting priority dstnat;
$dnat  }
  chain postrouting {
    type nat hook postrouting priority srcnat;
    ip saddr $LAB_CIDR oifname "$LAB_UPLINK" masquerade
  }
}
EOF
  cat >/etc/systemd/system/opendc-lab-nat.service <<'EOF'
# Managed by OpenDC test/env/proxmox/pve-lab.sh
[Unit]
Description=OpenDC lab NAT and isolation rules
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/opendc-lab/nat.nft
ExecStop=/usr/sbin/nft delete table inet opendc_lab

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable opendc-lab-nat.service >/dev/null 2>&1
  systemctl restart opendc-lab-nat.service
  ifreload -a
  ip -br addr show "$LAB_VNET" | grep -q "$LAB_GW/" || die "gateway address missing on $LAB_VNET after ifreload"
  log "network ready: $LAB_VNET $LAB_CIDR via $LAB_GW; port forwards: ${LAB_PORT_FORWARDS:-none}"
}

cmd_net_down() {
  [[ -z "$(cluster_vms | awk -v t="$LAB_TAG" '$4 ~ t && $4 !~ /template/')" ]] || die "Lab VMs still exist; run 'down <topology>' first"
  systemctl disable --now opendc-lab-nat.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/opendc-lab-nat.service /etc/network/interfaces.d/opendc-lab /etc/sysctl.d/90-opendc-lab.conf
  rm -rf /etc/opendc-lab
  systemctl daemon-reload
  sysctl -q -w net.ipv4.ip_forward=0
  log "templates still reference $LAB_VNET; removing them"
  cluster_vms | awk -v t="$LAB_TAG" '$4 ~ t && $4 ~ /template/ { print $1, $2 }' | while read -r id node; do
    pvesh delete "/nodes/$node/qemu/$id" --purge 1 >/dev/null
  done
  pvesh delete "/cluster/sdn/vnets/$LAB_VNET" >/dev/null 2>&1 || true
  pvesh delete "/cluster/sdn/zones/$LAB_ZONE" >/dev/null 2>&1 || true
  pvesh set /cluster/sdn >/dev/null
  log "network removed"
}

# ---------------------------------------------------------------- topology
topology_rows() { # prints "name image nodeidx ip cores mem disk role"
  local f="$LAB_DIR/topologies/$1.tsv"
  [[ -f "$f" ]] || die "Unknown topology '$1'; expected $f"
  grep -vE '^\s*(#|$)' "$f"
}
vmid_for_ip() { echo $((LAB_VMID_BASE + ${1##*.})); }

vm_keys() {
  cat /root/.ssh/id_rsa.pub
  [[ -f "$STATE_DIR/authorized_keys" ]] && cat "$STATE_DIR/authorized_keys"
  return 0
}

wait_ssh() { # <ip>
  for _ in $(seq 90); do
    ssh -n "${SSH_OPTS[@]}" "$LAB_CIUSER@$1" true 2>/dev/null && return 0
    sleep 2
  done
  die "No SSH on $1 after 180 s; check the VM console (qm terminal)"
}

cmd_up() {
  local topo="$1" name image idx ip cores mem disk node id tpl line keys
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  ip link show "$LAB_VNET" >/dev/null 2>&1 || cmd_net_up
  keys="$(vm_keys | urlencode)"
  while read -r name image idx ip cores mem disk _; do
    node="$(node_by_index "$idx")"
    [[ -n "$node" ]] || die "$name: node index $idx does not exist in this cluster"
    id="$(vmid_for_ip "$ip")"
    line="$(vm_line "$id")"
    if [[ -n "$line" ]]; then
      [[ "$line" == *"$LAB_TAG"* ]] || die "VMID $id exists and is not a lab VM; change LAB_VMID_BASE"
      log "$name ($id) exists"
    else
      tpl="$(template_id "$image" "$idx")"
      [[ -n "$(vm_line "$tpl")" ]] || cmd_templates
      log "cloning $name ($id) from $tpl on $node"
      pvesh create "/nodes/$node/qemu/$tpl/clone" --newid "$id" --name "$name" --full 0 >/dev/null
      pvesh set "/nodes/$node/qemu/$id/config" --tags "$LAB_TAG;topo-$topo" --cores "$cores" --memory "$mem" \
        --ciuser "$LAB_CIUSER" --sshkeys "$keys" --ipconfig0 "ip=$ip/$LAB_PREFIX,gw=$LAB_GW" \
        --nameserver "$LAB_DNS" --searchdomain "$topo.$LAB_DOMAIN_SUFFIX" --onboot 0 >/dev/null
      pvesh set "/nodes/$node/qemu/$id/resize" --disk scsi0 --size "${disk}G" >/dev/null
    fi
    # ask the node itself: /cluster/resources lags and can still show a destroyed VM's status for a reused id
    if [[ "$(pvesh get "/nodes/$node/qemu/$id/status/current" --output-format json | json 'print $d->{status}')" != running ]]; then
      pvesh create "/nodes/$node/qemu/$id/status/start" >/dev/null
    fi
  done < <(topology_rows "$topo")

  while read -r name image idx ip _; do
    wait_ssh "$ip"
    log "$name: base packages"
    # -n everywhere inside these loops: ssh must not consume the topology rows on stdin
    ssh -n "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" 'sudo cloud-init status --wait >/dev/null;
      command -v qemu-ga >/dev/null && command -v chronyd >/dev/null && exit 0
      sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq update &&
      sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq install -y qemu-guest-agent chrony >/dev/null &&
      sudo systemctl start qemu-guest-agent' ||
      die "$name: base package install failed"
    # Console (Proxmox xterm.js) and SSH password login for the lab user. SSH into the lab is only possible
    # through the gateway node (ssh -J root@<gateway> opendc@<ip>), so password auth stays inside the lab.
    lab_secret "vm-$LAB_CIUSER" | ssh "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" "sed 's/^/$LAB_CIUSER:/' | sudo chpasswd &&
      echo 'PasswordAuthentication yes' | sudo tee /etc/ssh/sshd_config.d/10-opendc-lab.conf >/dev/null &&
      sudo systemctl try-reload-or-restart ssh" || die "$name: setting the $LAB_CIUSER password failed"
  done < <(topology_rows "$topo")
  log "topology $topo is up"
  cmd_status
}

topo_vms() { # "<vmid> <node> <name>" of a topology's VMs that exist
  cluster_vms | awk -v t="topo-$1" '{ n = split($4, a, ";"); for (i = 1; i <= n; i++) if (a[i] == t) print $1, $2, $5 }'
}

cmd_down() {
  topo_vms "$1" | while read -r id node name; do
    vm_line "$id" | grep -q "$LAB_TAG" || continue
    log "destroying $name ($id) on $node"
    pvesh create "/nodes/$node/qemu/$id/status/stop" >/dev/null 2>&1 || true
    pvesh delete "/nodes/$node/qemu/$id" --purge 1 --destroy-unreferenced-disks 1 >/dev/null
    ssh-keygen -q -f "$KNOWN_HOSTS" -R "$(cut -d' ' -f4 <(topology_rows "$1" | awk -v n="$name" '$1 == n'))" 2>/dev/null || true
  done
}

cmd_snapshot() {
  topo_vms "$1" | while read -r id node name; do
    log "snapshot $name ($id): $2"
    pvesh create "/nodes/$node/qemu/$id/snapshot" --snapname "$2" --vmstate 0 >/dev/null
  done
}

cmd_rollback() {
  topo_vms "$1" | while read -r id node name; do
    log "rollback $name ($id) to $2"
    pvesh create "/nodes/$node/qemu/$id/snapshot/$2/rollback" --start 1 >/dev/null
  done
}

lab_secret() { # <name>  -> generated once, kept only on the gateway node
  local f="$STATE_DIR/secrets/$1"
  if [[ ! -s "$f" ]]; then
    mkdir -p "$STATE_DIR/secrets" && chmod 700 "$STATE_DIR/secrets"
    (umask 077; printf 'Lab-%s-9x\n' "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)" >"$f")
  fi
  head -n1 "$f"
}

cmd_domain() { # <topology>: provision the dc-primary, then join every dc
  local topo="$1" realm netbios primary_ip name ip role action
  realm="$(echo "$topo.$LAB_DOMAIN_SUFFIX" | tr '[:lower:]' '[:upper:]')"
  netbios="$(echo "$topo" | tr '[:lower:]' '[:upper:]' | cut -c1-15)"
  primary_ip="$(topology_rows "$topo" | awk '$8 == "dc-primary" { print $4 }')"
  [[ -n "$primary_ip" ]] || die "Topology $topo has no dc-primary"
  for role in dc-primary dc; do
    action=provision; [[ "$role" == dc ]] && action=join
    while read -r name ip; do
      log "$name: samba-dc $action"
      scp -q "${SSH_OPTS[@]}" "$LAB_DIR/roles/samba-dc.sh" "$LAB_CIUSER@$ip:/tmp/opendc-samba-dc.sh" </dev/null
      lab_secret "$topo-administrator" | ssh "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" \
        "sudo env ACTION=$action REALM=$realm NETBIOS=$netbios SELF_IP=$ip PRIMARY_IP=$primary_ip" \
        "FORWARDER=$LAB_FORWARDER BASE_SCHEMA=${BASE_SCHEMA:-} bash /tmp/opendc-samba-dc.sh" ||
        die "$name: samba-dc $action failed"
    done < <(topology_rows "$topo" | awk -v r="$role" '$8 == r { print $1, $4 }')
  done
  log "domain $realm is up (Administrator password: $STATE_DIR/secrets/$topo-administrator)"
}

cmd_credentials() { # print every lab login (for the operator at the gateway node's console)
  local f
  printf 'VM login (console + ssh -J root@%s): %s / %s\n' "$(hostname)" "$LAB_CIUSER" "$(lab_secret "vm-$LAB_CIUSER")"
  for f in "$STATE_DIR"/secrets/*-administrator; do
    [[ -e "$f" ]] || continue
    f="${f##*/}"
    printf 'Domain %s: %s\\Administrator / %s\n' "$(echo "${f%-administrator}.$LAB_DOMAIN_SUFFIX" | tr '[:lower:]' '[:upper:]')" \
      "$(echo "${f%-administrator}" | tr '[:lower:]' '[:upper:]' | cut -c1-15)" "$(head -n1 "$STATE_DIR/secrets/$f")"
  done
}

cmd_install_pkgs() { # <vm-name> <dir with .deb files on this node>
  local ip; ip="$(vm_ip "$1")"
  compgen -G "$2/*.deb" >/dev/null || die "No .deb files in $2"
  ssh -n "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" 'rm -rf /tmp/opendc-pkgs && mkdir -p /tmp/opendc-pkgs'
  scp -q "${SSH_OPTS[@]}" "$2"/*.deb "$LAB_CIUSER@$ip:/tmp/opendc-pkgs/" </dev/null
  ssh -n "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" \
    'sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq install -y /tmp/opendc-pkgs/*.deb' ||
    die "$1: package installation failed"
  log "$1: installed $(cd "$2" && ls ./*.deb | xargs -n1 basename | paste -sd' ')"
}

cmd_acceptance() { # <topology> <dir with .deb files>: install on the dc-primary, run the Phase 1 checks
  local topo="$1" name ip realm
  read -r name ip < <(topology_rows "$topo" | awk '$8 == "dc-primary" { print $1, $4 }')
  [[ -n "${name:-}" ]] || die "Topology $topo has no dc-primary"
  realm="$(echo "$topo.$LAB_DOMAIN_SUFFIX" | tr '[:lower:]' '[:upper:]')"
  cmd_install_pkgs "$name" "$2"
  lab_secret "$topo-administrator" | cmd_run "$name" "$LAB_DIR/roles/acceptance-phase1.sh" "REALM=$realm"
}

cmd_status() {
  printf '%-6s %-12s %-9s %-10s %s\n' VMID NODE STATUS NAME TAGS
  cluster_vms | awk -v t="$LAB_TAG" '$4 ~ t { printf "%-6s %-12s %-9s %-10s %s\n", $1, $2, $3, $5, $4 }' | sort -n
}

vm_ip() {
  local ip
  ip="$(cat "$LAB_DIR"/topologies/*.tsv | awk -v n="$1" '$1 == n { print $4 }')"
  [[ -n "$ip" ]] || die "No VM named $1 in any topology"
  echo "$ip"
}

cmd_ssh() { # <vm-name> [cmd...]
  local ip; ip="$(vm_ip "$1")"; shift
  exec ssh "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" "$@"
}

cmd_run() { # <vm-name> <script> [VAR=value...]: copy a script into the VM and run it as root; stdin is passed on
  local ip script="$2" vars; ip="$(vm_ip "$1")"; shift 2
  [[ -f "$script" ]] || die "No script $script"
  scp -q "${SSH_OPTS[@]}" "$script" "$LAB_CIUSER@$ip:/tmp/opendc-run.sh" </dev/null
  vars=""; (($#)) && printf -v vars '%q ' "$@"
  ssh "${SSH_OPTS[@]}" "$LAB_CIUSER@$ip" "sudo env $vars bash /tmp/opendc-run.sh"
}

case "${1:-}" in
  net-up) cmd_net_up ;;
  net-down) cmd_net_down ;;
  templates) cmd_templates "${2:-}" ;;
  up) cmd_up "${2:?topology}" ;;
  domain) cmd_domain "${2:?topology}" ;;
  down) cmd_down "${2:?topology}" ;;
  snapshot) cmd_snapshot "${2:?topology}" "${3:?snapshot name}" ;;
  rollback) cmd_rollback "${2:?topology}" "${3:?snapshot name}" ;;
  status) cmd_status ;;
  credentials) cmd_credentials ;;
  ssh) shift; cmd_ssh "$@" ;;
  run) shift; cmd_run "$@" ;;
  install-pkgs) cmd_install_pkgs "${2:?vm}" "${3:?package dir}" ;;
  acceptance) cmd_acceptance "${2:?topology}" "${3:?package dir}" ;;
  *) sed -n '/^# Usage:/,/^set /p' "${BASH_SOURCE[0]}" | sed '$d'; exit 2 ;;
esac
