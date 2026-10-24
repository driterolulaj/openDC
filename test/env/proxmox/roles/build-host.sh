#!/usr/bin/env bash
# Lab role: Linux build/test host. Runs as root inside the VM (pve-lab.sh run build1 roles/build-host.sh).
# Installs the pinned Node.js the packages bundle (checksum-verified) plus build tools. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_VERSION=24.22.1
NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6

apt-get -o DPkg::Lock::Timeout=600 -qq update
apt-get -o DPkg::Lock::Timeout=600 -qq install -y xz-utils git ca-certificates curl openssl >/dev/null

if [[ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c --quiet
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi
echo "build host ready: node $(node --version), npm $(npm --version)"
