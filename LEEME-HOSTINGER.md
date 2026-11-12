# Indiviso CMS en Hostinger

## Requisito
Plan con **Node.js web apps** (Business o Cloud). En planes de solo sitio web (Single/Premium) **no funciona**: no basta con subir el zip a `public_html` con el Administrador de archivos.

## Pasos
1. hPanel → **Sitios web → Agregar sitio web → Node.js web app → Subir archivos** → suba `indiviso-cms-hostinger.zip` (sin descomprimir).
2. Configuración:
   - **Versión de Node:** 22 o 24
   - **Archivo de entrada:** `app.js`
   - **Comando de instalación/compilación:** déjelos vacíos (no hay dependencias)
3. **Variables de entorno** (recomendado):
   - `INDIVISO_ADMIN_EMAIL` = su correo
   - `INDIVISO_ADMIN_PASSWORD` = una contraseña de 12+ caracteres con mayúsculas, minúsculas y números
4. **Desplegar** y abrir el dominio. Entre con ese correo y contraseña.

Si no definió las variables: el usuario es `admin@indiviso.local` y la contraseña temporal aparece en los **registros (logs)** de la app; el sistema pide cambiarla al entrar.

## Datos
Se guardan en `~/indiviso-datos` (fuera de la app), así que volver a desplegar no los borra. Respalde esa carpeta con regularidad; incluye las llaves `secreto.key` y `respaldo.key`.

## Si no abre
- Revise en el panel de la app la **versión de Node** (22 o 24) y el **archivo de entrada** (`app.js`).
- Abra los **registros (logs)**: ahí aparece el motivo exacto.
