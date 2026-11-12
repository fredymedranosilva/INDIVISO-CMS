#!/bin/sh
# Genera indiviso-cms-hostinger.zip: solo lo necesario para producción, sin datos, demo ni pruebas.
set -e
cd "$(dirname "$0")/.."
SALIDA="${1:-indiviso-cms-hostinger.zip}"
rm -f "$SALIDA"
zip -qr "$SALIDA" server.js package.json LEEME-HOSTINGER.md README.md public server scripts/restaurar.mjs \
  -x "server/seed.mjs" "*.DS_Store"
echo "Paquete listo: $SALIDA"
