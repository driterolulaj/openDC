#!/usr/bin/env bash
# Spike S1, part 1: schema matrix (ROADMAP Phase 1, ADR-0003 verification gate).
# Runs as root in a throwaway lab VM. For every base schema this Samba offers, it provisions a scratch domain
# into a --targetdir (the host's Samba configuration is never touched) and checks, directly on sam.ldb:
#   - msDS-App-Configuration and its carrier attributes exist (with rangeUpper / single-valued / linkID)
#   - msDS-cloudExtensionAttribute1..20 exist
#   - a platform container + msDS-App-Configuration object can be created and read back
#   - msDS-Settings accepts values of growing size (local constraint check, no LDAP PDU limit involved)
# Env: BACKPORTS=1 on Debian 12 upgrades Samba from bookworm-backports after the stock run and repeats.
# Output: markdown result lines on stdout.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /etc/os-release

install_samba() { # [apt target release]
  local pkgs=(samba ldb-tools)
  apt-cache show samba-ad-dc >/dev/null 2>&1 && pkgs+=(samba-ad-dc)
  apt-get -o DPkg::Lock::Timeout=600 -qq install -y ${1:+-t "$1"} "${pkgs[@]}" >/dev/null
  systemctl disable --now smbd nmbd winbind samba-ad-dc >/dev/null 2>&1 || true
}

ATTRS=(msDS-Settings msDS-ObjectReference msDS-Integer msDS-DateTime msDS-ByteArray)
SIZES=(1000 64000 500000 1000000 4000000)

run_matrix() {
  local ver schemas schema t b h out
  ver="$(samba --version | awk '{ print $2 }')"
  # optparse lists the valid choices only in the error for an invalid one
  schemas="$(samba-tool domain provision --base-schema=none 2>&1 | grep -oE "choose from .*" | grep -oE "'[^']+'" | tr -d "'" | xargs)"
  echo "### $PRETTY_NAME, Samba $ver"
  echo
  echo "Base schemas offered: \`$schemas\` (default: $(samba-tool domain provision --help | tr -s ' \n' ' ' | grep -oE 'base schema files to use\. Default is \(Windows\) [0-9_R]+' | awk '{ print $NF }'))"
  echo
  echo "| base schema | App-Configuration | carrier attrs (rangeUpper, single) | cloudExt 1..20 | create+read | msDS-Settings sizes accepted |"
  echo "|---|---|---|---|---|---|"
  mkdir -p /tmp/s1
  for schema in $schemas; do
    [[ "$schema" == *_old ]] && continue
    t="/tmp/s1/$schema"; rm -rf "$t"
    if ! samba-tool domain provision --targetdir="$t" --realm=S1.OPENDC.TEST --domain=S1 --server-role=dc \
      --dns-backend=NONE --use-rfc2307 --adminpass='S1-Spike-Pass-1' --base-schema="$schema" >"$t.log" 2>&1; then
      echo "| $schema | provision failed: $(tail -1 "$t.log") | | | | |"; continue
    fi
    h="$t/private/sam.ldb"; b="DC=s1,DC=opendc,DC=test"
    sch() { ldbsearch -H "$h" -b "CN=Schema,CN=Configuration,$b" "(lDAPDisplayName=$1)" "${@:2}" 2>/dev/null; }

    local cls="no" attrs="" a r s cloud=0 i create="fail" sizes=""
    sch msDS-App-Configuration | grep -q '^dn:' && cls="yes"
    for a in "${ATTRS[@]}"; do
      out="$(sch "$a" rangeUpper isSingleValued)"
      if grep -q '^dn:' <<<"$out"; then
        r="$(awk '/^rangeUpper:/ { print $2 }' <<<"$out")"; s="$(awk '/^isSingleValued:/ { print $2 }' <<<"$out")"
        attrs+="${a#msDS-} (${r:-none}, ${s,,}); "
      else
        attrs+="${a#msDS-} MISSING; "
      fi
    done
    for i in $(seq 1 20); do sch "msDS-cloudExtensionAttribute$i" | grep -q '^dn:' && cloud=$((cloud + 1)); done

    if ldbadd -H "$h" >/dev/null 2>&1 <<EOF
dn: CN=OpenDC,CN=System,$b
objectClass: container

dn: CN=Settings,CN=OpenDC,CN=System,$b
objectClass: msDS-App-Configuration
displayName: S1 test
msDS-Settings: opendc:v1:{"schemaVersion":1,"kind":"settings","rev":1}
msDS-ObjectReference: CN=Administrator,CN=Users,$b
msDS-Integer: 42
EOF
    then
      ldbsearch -H "$h" -b "CN=Settings,CN=OpenDC,CN=System,$b" -s base msDS-Settings 2>/dev/null |
        grep -q '"schemaVersion":1' && create="ok"
    fi
    for s in "${SIZES[@]}"; do
      if { printf 'dn: CN=Settings,CN=OpenDC,CN=System,%s\nchangetype: modify\nreplace: msDS-Settings\nmsDS-Settings:: ' "$b"
           head -c "$s" /dev/zero | tr '\0' 'x' | base64 -w0; printf '\n'; } |
         ldbmodify -H "$h" >/dev/null 2>&1; then
        sizes+="${s} ok, "
      else
        sizes+="${s} REJECTED, "
      fi
    done
    echo "| $schema | $cls | ${attrs%; } | $cloud/20 | $create | ${sizes%, } |"
    rm -rf "$t" "$t.log"
  done
  echo
}

apt-get -o DPkg::Lock::Timeout=600 -qq update
install_samba
run_matrix
if [[ "$VERSION_CODENAME" == bookworm && "${BACKPORTS:-1}" == 1 ]]; then
  echo "deb http://deb.debian.org/debian bookworm-backports main" >/etc/apt/sources.list.d/backports.list
  apt-get -o DPkg::Lock::Timeout=600 -qq update
  install_samba bookworm-backports
  run_matrix
fi
