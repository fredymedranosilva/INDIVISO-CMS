#!/bin/bash
# Indiviso CMS · doble clic para abrir en Mac (la primera vez: clic derecho → Abrir).
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Los datos se guardan fuera de iCloud (SQLite no debe sincronizarse mientras está abierto).
export INDIVISO_DATA="${INDIVISO_DATA:-$HOME/Indiviso-datos}"
PUERTO="${PORT:-4300}"
URL="http://localhost:$PUERTO"
salir() { echo; read -r -p "Presione Enter para cerrar esta ventana." _; exit "${1:-0}"; }

echo "=== Indiviso CMS ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Falta instalar Node.js (es gratuito)."
  echo "Se abrirá la página de descarga: elija la versión LTS para macOS, instálela y vuelva a abrir este archivo."
  open "https://nodejs.org/es/download"
  salir 1
fi
FLAGS=""
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  if node --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1; then FLAGS="--experimental-sqlite"
  else
    echo "Su Node.js ($(node -v)) es muy antiguo. Instale la versión LTS más reciente."
    open "https://nodejs.org/es/download"
    salir 1
  fi
fi

# ¿Ya hay algo en el puerto? Suele ser una versión anterior de Indiviso que quedó abierta.
PID=$(lsof -ti tcp:"$PUERTO" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$PID" ]; then
  echo "Ya hay un programa usando el puerto $PUERTO (probablemente una versión anterior de Indiviso)."
  read -r -p "¿Cerrarlo y abrir esta versión? (s/n) " R
  if [ "$R" = "s" ] || [ "$R" = "S" ]; then kill "$PID" 2>/dev/null; sleep 1; else open "$URL"; salir 0; fi
fi

if [ ! -f "$INDIVISO_DATA/indiviso.db" ]; then
  echo "Primera vez: creando datos de demostración en $INDIVISO_DATA …"
  node $FLAGS server/seed.mjs 2>/dev/null || { echo "No se pudieron crear los datos de demostración."; salir 1; }
fi
echo
echo "Usuarios de prueba (correo y contraseña):"
grep "@" "$INDIVISO_DATA/credenciales-demo.txt"
echo
echo "Abriendo $URL en su navegador. NO cierre esta ventana mientras use Indiviso."
(sleep 2; open "$URL") &
PORT="$PUERTO" node $FLAGS server/index.mjs 2>/dev/null
salir 0
