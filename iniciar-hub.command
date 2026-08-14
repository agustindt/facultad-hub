#!/bin/bash
# Doble clic para levantar el Hub Facultad.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Instalalo con:  brew install node"
  echo "Cuando termine, volvé a hacer doble clic acá."
  read -r -p "Enter para cerrar..."
  exit 1
fi

PORT="${PORT:-4177}"
( sleep 1.5; open "http://localhost:$PORT" ) &
PORT="$PORT" node server.js
