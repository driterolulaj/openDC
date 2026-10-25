#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -e
if [ -d /run/systemd/system ] && [ "${1:-remove}" = "remove" ]; then
  systemctl disable --now opendc-api.service opendc-watcher.service opendc-agent.service \
    opendc-agent-api.socket opendc-agent-watch.socket opendc-agent-cli.socket opendc-secrets-init.service \
    opendc-sdprop.timer >/dev/null 2>&1 || true
fi
