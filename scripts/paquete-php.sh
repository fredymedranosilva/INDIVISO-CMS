#!/bin/sh
# Genera indiviso-cms-php.zip para hospedaje compartido SIN Node.js (Hostinger, cPanel): se descomprime en public_html.
# Contiene la interfaz (public/) y la API en PHP (php/). Sin datos, demo ni pruebas.
set -e
cd "$(dirname "$0")/.."
SALIDA="$(pwd)/${1:-indiviso-cms-php.zip}"
TMP="$(mktemp -d)"
cp -R public/. "$TMP/"
cp php/api.php php/.htaccess php/config-ejemplo.php "$TMP/"
mkdir -p "$TMP/app" && cp php/app/*.php php/app/esquema.sql php/app/.htaccess "$TMP/app/"
rm -f "$SALIDA"
(cd "$TMP" && zip -qrX "$SALIDA" . -x "*.DS_Store")
rm -rf "$TMP"
echo "Paquete listo: $SALIDA"
