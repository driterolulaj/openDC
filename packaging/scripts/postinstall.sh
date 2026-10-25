#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Creates users and directories and (re)starts the services. Never provisions or joins anything (ADR-0016).
set -e
systemd-sysusers /usr/lib/sysusers.d/opendc.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/opendc.conf
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable opendc-secrets-init.service opendc-agent-api.socket opendc-agent-watch.socket opendc-agent-cli.socket opendc-api.service opendc-watcher.service opendc-sdprop.timer opendc-pki.timer >/dev/null
  systemctl start opendc-sdprop.timer opendc-pki.timer
  systemctl restart opendc-secrets-init.service
  systemctl restart opendc-agent-api.socket opendc-agent-watch.socket opendc-agent-cli.socket
  # A running agent keeps the old code; restart it (it is socket-activated, so a stopped one is fine too).
  systemctl try-restart opendc-agent.service
  systemctl restart opendc-api.service opendc-watcher.service
fi
if [ ! -f /etc/opendc/node.json ] && [ -s /etc/opendc/secrets/setup-token ]; then
  echo "OpenDC is installed but not set up yet."
  echo "  Setup token: $(cat /etc/opendc/secrets/setup-token)"
  echo "  Wizard:      https://$(hostname -f 2>/dev/null || hostname):8443/console/setup"
  echo "  CLI:         sudo opendc setup --help"
fi
