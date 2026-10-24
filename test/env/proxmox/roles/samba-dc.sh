#!/usr/bin/env bash
# Lab role: Samba AD DC. Runs as root inside a lab VM (piped in by pve-lab.sh 'domain').
# Line 1 of stdin is the domain Administrator password; nothing else is read from stdin.
#
# Env: ACTION=provision|join  REALM  NETBIOS  SELF_IP  PRIMARY_IP (join)  FORWARDER  BASE_SCHEMA (optional)
#
# This is lab plumbing, not the product: Phase 2 replaces it with the agent's samba.provision / samba.join.
set -euo pipefail
: "${ACTION:?}" "${REALM:?}" "${NETBIOS:?}" "${SELF_IP:?}" "${FORWARDER:?}"
IFS= read -r ADMINPASS
export DEBIAN_FRONTEND=noninteractive

short="$(hostname -s)"
domain="${REALM,,}"
fqdn="$short.$domain"
log() { printf '[%s] %s\n' "$short" "$*" >&2; }

if [[ -f /var/lib/samba/private/sam.ldb ]]; then
  log "already a DC; nothing to do"
  exit 0
fi

# cloud-init must not rewrite hosts/resolver or the hostname on later boots
cat >/etc/cloud/cloud.cfg.d/99-opendc-lab.cfg <<'EOF'
manage_etc_hosts: false
manage_resolv_conf: false
preserve_hostname: true
EOF
sed -i "/[[:space:]]$short\([[:space:]]\|$\)/d" /etc/hosts
echo "$SELF_IP $fqdn $short" >>/etc/hosts

write_resolv() { # <nameserver>...
  systemctl disable --now systemd-resolved >/dev/null 2>&1 || true
  rm -f /etc/resolv.conf
  { printf 'search %s\n' "$domain"; printf 'nameserver %s\n' "$@"; } >/etc/resolv.conf
}

log "installing Samba AD DC packages"
# Resolve through the forwarder while installing; a joining DC switches to the primary right after.
write_resolv "$FORWARDER"
printf 'krb5-config krb5-config/default_realm string %s\n' "$REALM" | debconf-set-selections
apt-get -o DPkg::Lock::Timeout=600 -qq update
apt-get -o DPkg::Lock::Timeout=600 -qq install -y samba samba-ad-dc winbind krb5-user libnss-winbind \
  libpam-winbind ldb-tools smbclient dnsutils >/dev/null
for unit in smbd nmbd winbind; do systemctl disable --now "$unit" >/dev/null 2>&1 || true; done
systemctl mask smbd nmbd winbind >/dev/null 2>&1 || true
rm -f /etc/samba/smb.conf

case "$ACTION" in
  provision)
    log "provisioning $REALM ($NETBIOS)${BASE_SCHEMA:+ base schema $BASE_SCHEMA}"
    samba-tool domain provision --realm="$REALM" --domain="$NETBIOS" --server-role=dc \
      --dns-backend=SAMBA_INTERNAL --use-rfc2307 --adminpass="$ADMINPASS" \
      --option="dns forwarder = $FORWARDER" ${BASE_SCHEMA:+--base-schema="$BASE_SCHEMA"} >/dev/null
    ;;
  join)
    : "${PRIMARY_IP:?}"
    write_resolv "$PRIMARY_IP"
    cat >/etc/krb5.conf <<EOF
[libdefaults]
	default_realm = $REALM
	dns_lookup_realm = false
	dns_lookup_kdc = true
EOF
    log "joining $REALM as writable DC via $PRIMARY_IP"
    samba-tool domain join "$REALM" DC -U"$NETBIOS\\Administrator" --password="$ADMINPASS" \
      --dns-backend=SAMBA_INTERNAL --option="dns forwarder = $FORWARDER" \
      --option="idmap_ldb:use rfc2307 = yes" >/dev/null
    ;;
  *) echo "ACTION must be provision or join" >&2; exit 2 ;;
esac

cp /var/lib/samba/private/krb5.conf /etc/krb5.conf
systemctl unmask samba-ad-dc >/dev/null
systemctl enable --now samba-ad-dc >/dev/null
if [[ "$ACTION" == join ]]; then write_resolv "$SELF_IP" "$PRIMARY_IP"; else write_resolv "$SELF_IP"; fi

for _ in $(seq 60); do
  host -t SRV "_ldap._tcp.$domain" "$SELF_IP" >/dev/null 2>&1 && break
  sleep 2
done
host -t SRV "_ldap._tcp.$domain" "$SELF_IP" >/dev/null || { log "DNS SRV lookup failed"; exit 1; }
log "DC ready: $(samba --version)"
