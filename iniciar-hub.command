#!/bin/bash
# Arranca el hub sin contenedores. Doble clic acá.
cd "$(dirname "$0")"
echo "Hub Facultad — arrancando…"
node backend/server.js
