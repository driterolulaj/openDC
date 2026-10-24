#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# OpenDC tarball installer for hosts where the .deb/.rpm packages aren't used (ADR-0016).
# Installs the files, creates users and directories and starts the services. It never provisions
# a domain or joins one: that is the setup wizard's job.
#
#   sudo ./install.sh            install or upgrade
#   sudo ./install.sh --uninstall
set -eu

here=$(cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root (sudo ./install.sh)" >&2
  exit 1
fi
if [ ! -d /run/systemd/system ]; then
  echo "OpenDC needs systemd as the init system" >&2
  exit 1
fi

case "${1:-}" in
  --uninstall)
    sh "$here/preremove.sh" remove
    rm -rf /usr/lib/opendc /usr/bin/opendc /usr/lib/sysusers.d/opendc.conf /usr/lib/tmpfiles.d/opendc.conf
    for unit in opendc-agent.service opendc-api.service opendc-watcher.service opendc-secrets-init.service \
      opendc-agent-api.socket opendc-agent-watch.socket opendc-agent-cli.socket; do
      rm -f "/usr/lib/systemd/system/$unit"
    done
    sh "$here/postremove.sh" remove
    echo "OpenDC removed. Configuration and state remain in /etc/opendc and /var/lib/opendc."
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [--uninstall]" >&2
    exit 2
    ;;
esac

for cmd in tar systemctl systemd-sysusers systemd-tmpfiles openssl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "missing required command: $cmd" >&2
    exit 1
  }
done

tar -xzf "$here/payload.tar.gz" -C / --no-same-owner --no-overwrite-dir
sh "$here/postinstall.sh" configure
echo "OpenDC installed. Console: https://$(hostname -f 2>/dev/null || hostname):8443/"
