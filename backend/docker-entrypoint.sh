#!/bin/sh
set -e
mkdir -p /vault /app/datos
chown node:node /vault /app/datos
exec su-exec node "$@"
