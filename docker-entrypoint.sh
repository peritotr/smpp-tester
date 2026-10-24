#!/bin/sh
# The /data bind mount is created as root; the app runs as the unprivileged 'node' user, so fix ownership first.
set -e
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}"
exec su-exec node "$@"
