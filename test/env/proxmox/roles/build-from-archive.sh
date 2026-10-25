#!/usr/bin/env bash
# Lab role: build OpenDC packages on the build host from a source tarball on stdin (run as root by
# 'pve-lab.sh run build1 roles/build-from-archive.sh < src.tar'). Builds as the lab user in ~/src, then
# leaves the packages in ~/src/packaging/out. Env: CHECK=0 skips `npm run check` for quick iterations.
set -euo pipefail
user="${SUDO_USER:-opendc}"
home="$(getent passwd "$user" | cut -d: -f6)"
src="$home/src"

# keep node_modules between builds; replace everything else with the archive's content
find "$src" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true
install -d -o "$user" -g "$user" "$src"
tar -C "$src" -xf - --no-same-owner
chown -R "$user:$user" "$src"

sudo -u "$user" -H env CHECK="${CHECK:-1}" PATH="/opt/node/bin:/usr/local/bin:/usr/bin:/bin" bash -c '
  set -euo pipefail
  cd ~/src
  echo "== npm ci"; npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -2
  echo "== build"; npm run build 2>&1 | tail -2
  if [[ "$CHECK" == 1 ]]; then
    echo "== check"; npm run check 2>&1 | grep -E "^ℹ (tests|pass|fail)|Tests |all files|error|✖|Error" | head -40
  fi
  echo "== package"; rm -rf packaging/out; npm run package 2>&1 | tail -4
'
echo BUILD-DONE
