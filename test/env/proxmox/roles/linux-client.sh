#!/usr/bin/env bash
# Lab role: Linux domain member (client) through realmd/sssd. Runs as root inside a lab VM:
#   pve-lab.sh run client1 roles/linux-client.sh REALM=STANDARD.OPENDC.TEST DC_IPS="10.97.10.11 10.97.10.12" \
#     JOIN_USER=<domain admin>   (line 1 of stdin: that account's password; nothing else is read from stdin)
#
# Members read the RID-based uidNumber/gidNumber that OpenDC writes (ADR-0018): sssd with ldap_id_mapping = False.
# Debian/Ubuntu. Lab plumbing for acceptance 4, not the product.
set -euo pipefail
: "${REALM:?}" "${DC_IPS:?}" "${JOIN_USER:?}"
IFS= read -r JOIN_PASS
export DEBIAN_FRONTEND=noninteractive
domain="${REALM,,}"
short="$(hostname -s)"
log() { printf '[%s] %s\n' "$short" "$*" >&2; }

apt-get -qq update
apt-get -qq install -y realmd sssd sssd-tools libnss-sss libpam-sss adcli samba-common-bin krb5-user \
  packagekit sshpass >/dev/null

# the domain's names come from its DCs; everything else from the existing resolver
if systemctl is-active -q systemd-resolved; then
  mkdir -p /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNS=%s\nDomains=~%s %s\n' "$DC_IPS" "$domain" "$domain" >/etc/systemd/resolved.conf.d/opendc-lab.conf
  systemctl restart systemd-resolved
else
  { printf 'search %s\n' "$domain"; for ip in $DC_IPS; do printf 'nameserver %s\n' "$ip"; done; } >/etc/resolv.conf
fi
cat >/etc/cloud/cloud.cfg.d/99-opendc-lab.cfg <<'EOF'
manage_etc_hosts: false
preserve_hostname: true
EOF
hostnamectl set-hostname "$short.$domain"
getent ahosts "$domain" >/dev/null || {
  log "the domain $domain doesn't resolve through $DC_IPS"
  exit 1
}

if realm list --name-only | grep -qx "$domain"; then
  log "already joined to $domain"
else
  printf '%s\n' "$JOIN_PASS" | realm join --user="$JOIN_USER" "$domain"
  log "joined $domain"
fi

# POSIX IDs from the directory (idBase + RID), not sssd's own hash mapping
conf=/etc/sssd/sssd.conf
if grep -q '^ldap_id_mapping' "$conf"; then
  sed -i 's/^ldap_id_mapping.*/ldap_id_mapping = False/' "$conf"
else
  sed -i "/^\[domain\/$domain\]/a ldap_id_mapping = False" "$conf"
fi
pam-auth-update --enable mkhomedir
systemctl restart sssd
sss_cache -E
log "sssd: ldap_id_mapping = False; home directories created at first login"
