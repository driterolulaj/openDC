#!/usr/bin/env bash
# Spike S1, part 2: live two-DC checks (ADR-0003 points 2, 4 and 5).
# Runs as root on a joined second DC. Writes go over LDAPS-less LDAP with signing (Samba default) to the
# primary DC as a real client would; reads after replication come from the local sam.ldb.
# Line 1 of stdin: domain Administrator password.  Env: REALM  NETBIOS  PRIMARY (short hostname of dc1)
# Output: markdown result lines on stdout. Cleans up everything it creates.
set -uo pipefail
: "${REALM:?}" "${NETBIOS:?}" "${PRIMARY:?}"
IFS= read -r PW
domain="${REALM,,}"
self="$(hostname -s)"
b="DC=${domain//./,DC=}"
auth="$(mktemp)"; chmod 600 "$auth"
trap 'rm -f "$auth"' EXIT
printf 'username=Administrator\npassword=%s\ndomain=%s\n' "$PW" "$NETBIOS" >"$auth"
remote=(-H "ldap://$PRIMARY.$domain" -A "$auth")
local_db=(-H /var/lib/samba/private/sam.ldb)
c="CN=OpenDC-S1-$self-$(date +%s),CN=System,$b"   # unique spike-only container, removed at the end
obj="CN=Settings,$c"

result() { printf '| %s | %s |\n' "$1" "$2"; }
unwrap() { sed -e ':a' -e '$!N;s/\n //;ta' -e 'P;D'; }   # join folded LDIF continuation lines
value_len() { # <ldb url> <attr>: length of the (single) value; ldbsearch prints plain or base64 (::)
  ldbsearch -H "$1" -A "$auth" -b "$obj" -s base "$2" 2>/dev/null | unwrap | awk -v a="$2" '
    index($0, a ":: ") == 1 { print substr($0, length(a) + 4) | "base64 -d | wc -c"; exit }
    index($0, a ": ") == 1 { print length($0) - length(a) - 2; exit }'
}
repl() { samba-tool drs replicate "$self" "$PRIMARY" "$b" >/dev/null 2>&1; }

echo "### Live: $(samba --version) on $self, writes to $PRIMARY"
echo
echo "| check | result |"
echo "|---|---|"

out="$(ldbadd "${remote[@]}" 2>&1 <<EOF
dn: $c
objectClass: container

dn: $obj
objectClass: msDS-App-Configuration
displayName: S1 settings
msDS-Settings: opendc:v1:{"schemaVersion":1,"kind":"settings","rev":1}
msDS-ObjectReference: CN=Administrator,CN=Users,$b
EOF
)" && result "create container + msDS-App-Configuration over LDAP on $PRIMARY" ok ||
  result "create over LDAP on $PRIMARY" "FAILED: $(grep -oE 'LDAP error [0-9]+ [A-Z_]+' <<<"$out" | head -1)"

t0=$(date +%s)
for _ in $(seq 60); do
  ldbsearch "${local_db[@]}" -b "$obj" -s base msDS-Settings 2>/dev/null | grep -q '"rev":1' && break
  sleep 2
done
if ldbsearch "${local_db[@]}" -b "$obj" -s base msDS-Settings 2>/dev/null | grep -q '"rev":1'; then
  result "replicated to $self (change notification, no forced replicate)" "ok after $(($(date +%s) - t0)) s"
else
  repl
  result "replicated to $self" "not within 120 s; after forced drs replicate: $(ldbsearch "${local_db[@]}" -b "$obj" -s base msDS-Settings 2>/dev/null | grep -c '"rev":1')"
fi
bl="$(ldbsearch "${local_db[@]}" -b "CN=Administrator,CN=Users,$b" -s base msDS-ObjectReferenceBL 2>/dev/null | unwrap | grep -ci "^msDS-ObjectReferenceBL: $obj$")"
result "msDS-ObjectReferenceBL back-link on target (on $self)" "$([[ $bl == 1 ]] && echo ok || echo MISSING)"

# CAS: delete the exact old value and add the new one in one modify (ADR-0003 point 5)
cas() { # <old> <new>
  ldbmodify "${remote[@]}" 2>&1 <<EOF
dn: $obj
changetype: modify
delete: msDS-Settings
msDS-Settings: $1
-
add: msDS-Settings
msDS-Settings: $2
EOF
}
v1='opendc:v1:{"schemaVersion":1,"kind":"settings","rev":1}'
v2='opendc:v1:{"schemaVersion":1,"kind":"settings","rev":2}'
v3='opendc:v1:{"schemaVersion":1,"kind":"settings","rev":3}'
out="$(cas "$v1" "$v2")" && result "CAS rev1->rev2 with current old value" ok || result "CAS rev1->rev2" "FAILED: $(tail -1 <<<"$out")"
out="$(cas "$v1" "$v3")" && result "CAS with stale old value (must fail)" "UNEXPECTEDLY SUCCEEDED" ||
  result "CAS with stale old value (must fail)" "rejected: $(grep -oE 'LDAP error [0-9]+ [A-Z_]+' <<<"$out" | head -1)"
n="$(ldbsearch "${remote[@]}" -b "$obj" -s base msDS-Settings 2>/dev/null | grep -c '^msDS-Settings')"
result "msDS-Settings value count after CAS" "$n (expected 1)"

# Size limits over LDAP. msDS-Settings has rangeUpper 1000000 (characters, per value), which Samba enforces.
sizes=""
for s in 64000 500000 1000000 1000001 4000000; do
  out="$({ printf 'dn: %s\nchangetype: modify\nreplace: msDS-Settings\nmsDS-Settings:: ' "$obj"
       head -c "$s" /dev/zero | tr '\0' 'x' | base64 -w0; printf '\n'; } | ldbmodify "${remote[@]}" 2>&1)" &&
    sizes+="$s ok, " || sizes+="$s rejected ($(grep -oE 'LDAP error [0-9]+ [A-Z_]+' <<<"$out" | head -1)), "
done
result "msDS-Settings value size over LDAP" "${sizes%, }"
{ printf 'dn: %s\nchangetype: modify\nreplace: msDS-Settings\nmsDS-Settings:: ' "$obj"
  head -c 1000000 /dev/zero | tr '\0' 'x' | base64 -w0; printf '\n'; } | ldbmodify "${remote[@]}" >/dev/null 2>&1
repl
result "1000000-char value replicated intact" "$(value_len /var/lib/samba/private/sam.ldb msDS-Settings) chars on $self"

# Extended attributes on a user (ADR-0003 point 4)
out="$(ldbmodify "${remote[@]}" 2>&1 <<EOF
dn: CN=Administrator,CN=Users,$b
changetype: modify
replace: msDS-cloudExtensionAttribute1
msDS-cloudExtensionAttribute1: s1-test
-
replace: msDS-cloudExtensionAttribute20
msDS-cloudExtensionAttribute20: s1-test-20
EOF
)" && result "write msDS-cloudExtensionAttribute1 and 20 on a user" ok || result "write cloudExtensionAttribute" "FAILED: $(tail -1 <<<"$out")"
repl
n="$(ldbsearch "${local_db[@]}" -b "CN=Administrator,CN=Users,$b" -s base msDS-cloudExtensionAttribute1 msDS-cloudExtensionAttribute20 2>/dev/null | grep -c '^msDS-cloudExtensionAttribute')"
result "cloudExtensionAttribute values replicated to $self" "$n/2"
out="$(ldbmodify "${remote[@]}" 2>&1 <<EOF
dn: CN=Administrator,CN=Users,$b
changetype: modify
add: msDS-cloudExtensionAttribute1
msDS-cloudExtensionAttribute1: second-value
EOF
)" && result "cloudExtensionAttribute is single-valued (second add must fail)" "UNEXPECTEDLY SUCCEEDED" ||
  result "cloudExtensionAttribute is single-valued (second add must fail)" rejected

result "base schema version (objectVersion)" "$(ldbsearch "${local_db[@]}" -b "CN=Schema,CN=Configuration,$b" -s base objectVersion 2>/dev/null | awk '/^objectVersion:/ { print $2 }')"
result "domain / forest functional level" "$(samba-tool domain level show 2>/dev/null | awk -F': ' '/Domain function level|Forest function level/ { printf "%s; ", $2 }')"

# Cleanup
ldbmodify "${remote[@]}" >/dev/null 2>&1 <<EOF
dn: CN=Administrator,CN=Users,$b
changetype: modify
delete: msDS-cloudExtensionAttribute1
-
delete: msDS-cloudExtensionAttribute20
EOF
ldbdel "${remote[@]}" -r "$c" >/dev/null 2>&1 && result cleanup ok || result cleanup "FAILED (remove $c manually)"
echo
