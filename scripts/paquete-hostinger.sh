#!/bin/sh
# Genera indiviso-cms-hostinger.zip con lo indispensable: app.js, package.json, server/ y public/. Sin datos, demo ni pruebas.
set -e
cd "$(dirname "$0")/.."
SALIDA="$(pwd)/${1:-indiviso-cms-hostinger.zip}"
TMP="$(mktemp -d)"
cp scripts/hostinger/app.js scripts/hostinger/package.json "$TMP/"
mkdir -p "$TMP/server" && cp server/*.mjs "$TMP/server/" && rm -f "$TMP/server/seed.mjs"
cp -R public "$TMP/public"
rm -f "$SALIDA"
(cd "$TMP" && zip -qrX "$SALIDA" app.js package.json server public -x "*.DS_Store")
rm -rf "$TMP"
echo "Paquete listo: $SALIDA"
