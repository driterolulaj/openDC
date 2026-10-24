#!/usr/bin/env bash
# Phase 1 acceptance checks 3-5 (ROADMAP), run as root inside a lab DC after the packages are installed.
# Line 1 of stdin: the domain Administrator password. Env: REALM. Prints a markdown table; exit 1 on failure.
set -uo pipefail
: "${REALM:?}"
IFS= read -r ADMINPASS
fqdn="$(hostname -f)"
base="https://localhost:8443"
fail=0
row() { printf '| %s | %s | %s |\n' "$1" "$2" "$3"; [[ "$2" == ok ]] || fail=1; }
jar="$(mktemp)"
trap 'rm -f "$jar" /tmp/opendc-login.json' EXIT

echo "| check | result | detail |"
echo "|---|---|---|"

# --- Acceptance 3: installed, hardened, HTTPS console --------------------------------------------
v="$(dpkg-query -W -f='${Version}' opendc-common 2>/dev/null)"
row "3 .deb installed" "$([[ -n "$v" ]] && echo ok || echo FAIL)" "opendc-common $v, opendc-web $(dpkg-query -W -f='${Version}' opendc-web 2>/dev/null)"
for u in opendc-agent-api.socket opendc-agent-watch.socket opendc-agent-cli.socket opendc-api.service opendc-watcher.service; do
  s="$(systemctl is-active "$u")"
  row "3 $u" "$([[ "$s" == active ]] && echo ok || echo FAIL)" "$s"
done
for u in opendc-api opendc-watcher; do
  # "→ Overall exposure level for opendc-api.service: 2.1 OK 🙂": take the number after the colon
  e="$(systemd-analyze security "$u.service" --no-pager 2>/dev/null | grep -o 'Overall exposure level for [^:]*: [0-9.]*' | grep -o '[0-9.]*$')"
  ok="$(awk -v e="${e:-99}" 'BEGIN { print (e <= 3.0) ? "ok" : "FAIL" }')"
  row "3 systemd-analyze security $u" "$ok" "exposure ${e:-?} (limit 3.0)"
done
html="$(curl -sk "$base/console/")"
row "3 console login page over HTTPS" "$([[ "$html" == *"<title>OpenDC</title>"* ]] && echo ok || echo FAIL)" "$(curl -sk -o /dev/null -w '%{http_code} %{content_type}' "$base/console/")"
cert="$(echo | openssl s_client -connect localhost:8443 -servername "$fqdn" 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | tr '\n' ' ')"
row "3 TLS certificate" "$([[ "$cert" == *"$fqdn"* ]] && echo ok || echo FAIL)" "${cert:0:160}"

# --- Acceptance 4: LDAPS login, RBAC-filtered permissions, audited ------------------------------
opendc registry set core.directory.ldapUrls "[\"ldaps://$fqdn\"]" >/dev/null
systemctl restart opendc-api
for _ in $(seq 30); do curl -sk "$base/api/v1/health" >/dev/null && break; sleep 1; done
login() { # <user> <password> [cookie jar] -> http status; body in /tmp/opendc-login.json
  python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.stdin.read().rstrip("\n")}))' "$1" <<<"$2" |
    curl -sk -o /tmp/opendc-login.json -w '%{http_code}' -c "${3:-$jar}" -H 'content-type: application/json' -H "origin: https://localhost:8443" --data-binary @- "$base/api/v1/session"
}
status="$(login Administrator "$ADMINPASS")"
row "4 Administrator logs in via LDAPS" "$([[ "$status" == 200 ]] && echo ok || echo FAIL)" "HTTP $status $(head -c 160 /tmp/opendc-login.json)"
perms="$(curl -sk -b "$jar" "$base/api/v1/session/permissions")"
row "4 RBAC: Domain Admin role resolved from tokenGroups" "$([[ "$perms" == *core.console.access* && "$perms" == *'"tier0":true'* ]] && echo ok || echo FAIL)" "$(grep -o '"permission":"[^"]*"' <<<"$perms" | cut -d'"' -f4 | paste -sd, -)"
node="$(curl -sk -b "$jar" "$base/api/v1/node")"
row "4 node info through the agent" "$([[ "$node" == *'"role"'* ]] && echo ok || echo FAIL)" "${node:0:160}"
audit="$(curl -sk -b "$jar" "$base/api/v1/audit?limit=5")"
row "4 login is in the audit log" "$([[ "$audit" == *'"action":"session.login","result":"success"'* ]] && echo ok || echo FAIL)" "$(grep -o '"actor":"[^"]*","actorSid":"[^"]*","sourceIp":"[^"]*","action":"session.login","result":"[a-z]*"' <<<"$audit" | head -1)"
# A regular domain user has no console role: refused (and audited).
user="opendc-accept-$RANDOM"
pw="Acc-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)-9x"
samba-tool user create "$user" "$pw" >/dev/null 2>&1
status="$(login "$user" "$pw" /dev/null)"
row "4 user without a console role is refused" "$([[ "$status" == 403 ]] && echo ok || echo FAIL)" "HTTP $status $(grep -o '"code":"[^"]*"' /tmp/opendc-login.json)"
samba-tool user delete "$user" >/dev/null 2>&1
status="$(login Administrator wrong-password /dev/null)"
row "4 wrong password is rejected" "$([[ "$status" == 401 ]] && echo ok || echo FAIL)" "HTTP $status $(grep -o '"code":"[^"]*"' /tmp/opendc-login.json)"
db="$(curl -sk -b "$jar" "$base/api/v1/audit?limit=10" | grep -o '"result":"[a-z]*"' | sort | uniq -c | xargs)"
row "4 audit has success, denied and failure entries" "$([[ "$db" == *success* && "$db" == *denied* && "$db" == *failure* ]] && echo ok || echo FAIL)" "$db"

# --- Acceptance 5: registry set renders through the agent with the header; drift detection -----
out="$(opendc registry set core.demo.message 'Hello from the acceptance test' 2>&1)"
demo=/etc/opendc/generated/demo.conf
head1="$(head -1 "$demo" 2>/dev/null)"
row "5 registry set renders the managed file through the agent" "$([[ "$head1" == "# Generated by OpenDC (module core, template core.demo). DO NOT EDIT"* ]] && grep -q 'message = Hello from the acceptance test' "$demo" && echo ok || echo FAIL)" "$(stat -c '%U:%G %a' "$demo" 2>/dev/null) ${head1:0:90}; $(tail -1 <<<"$out")"
opendc registry drift >/dev/null 2>&1; d0=$?
echo "manual = edit" >>"$demo"
d1out="$(opendc registry drift 2>&1)"; d1=$?
row "5 drift diagnostic flags a manual edit" "$([[ $d0 == 0 && $d1 == 1 && "$d1out" == *"core.demo: modified by hand"* ]] && echo ok || echo FAIL)" "before: exit $d0; after edit: exit $d1, $(grep core.demo <<<"$d1out" | xargs)"
opendc registry commit >/dev/null 2>&1
opendc registry drift >/dev/null 2>&1; d2=$?
row "5 registry commit repairs the drift" "$([[ $d2 == 0 ]] && ! grep -q 'manual = edit' "$demo" && echo ok || echo FAIL)" "drift exit $d2; previous version kept as $(ls "$demo".opendc-prev 2>/dev/null)"
journal="$(journalctl -u opendc-agent --since '-10 min' --no-pager -o cat 2>/dev/null | grep -c '"op":"file.writeManaged"')"
row "5 agent journal records the writes (no contents)" "$([[ "$journal" -ge 1 ]] && ! journalctl -u opendc-agent --since '-10 min' --no-pager -o cat | grep -q 'Hello from the acceptance test' && echo ok || echo FAIL)" "$journal file.writeManaged entries, file contents not logged"

exit $fail
