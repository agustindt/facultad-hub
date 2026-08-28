#!/bin/bash
# Empaqueta "Facultad Hub.app" y deja el DMG en app/dist/. Doble clic y listo.
cd "$(dirname "$0")"
npm install
npm run dist
open dist
