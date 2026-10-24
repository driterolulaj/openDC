#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Configuration, secrets and state stay on remove; purge removes them (the audit log goes with the state).
set -e
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
if [ "${1:-}" = "purge" ]; then
  rm -rf /etc/opendc /var/lib/opendc /run/opendc
fi
