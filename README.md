# Indiviso CMS — gestión financiera condominal

Node 24 + SQLite embebido (`node:sqlite`), sin dependencias externas.

## Arranque local (pruebas)
```bash
cd plataforma
node server/seed.mjs          # crea la demo (usa --reset para regenerarla; borra todos los datos)
node server/index.mjs         # http://localhost:4300
node --test test/*.test.mjs   # pruebas de integridad
```
Usuarios de prueba y contraseñas: `data/credenciales-demo.txt`.

## Producción
- `HOST=127.0.0.1 PORT=4300 INDIVISO_HTTPS=1 INDIVISO_TRUST_PROXY=1 node server/index.mjs`, detrás de Caddy/Nginx con HTTPS.
- `INDIVISO_BACKUP_KEY` (32 bytes en base64) o el archivo `data/respaldo.key`: **guárdela fuera del servidor**; sin ella los respaldos no se descifran.
- Copie `data/respaldos/` a un destino externo a diario (regla 3-2-1). Restaurar: `node scripts/restaurar.mjs <archivo.idvb> [--aplicar]`.
- Base vacía para un cliente real: `node server/seed.mjs --vacio`.

## Importar desde Excel
Pagos, egresos, proveedores, directorio (unidades y residentes), saldos iniciales y presupuesto se cargan desde **.xlsx**, **.csv** o celdas pegadas de Excel (botón «Importar desde Excel» en cada sección).
- Cada sección ofrece una **plantilla .xlsx** con hojas de catálogos (unidades, cuentas, partidas, formas de pago). El directorio y el presupuesto se exportan y se vuelven a importar ya editados.
- Antes de guardar se muestra una **vista previa validada fila por fila** por el mismo motor que la captura manual; las filas con error no se importan y se pueden descargar para corregirlas.
- Reimportar el mismo archivo **no duplica** pagos ni egresos. Acepta encabezados y formatos de otros sistemas (p. ej. Vivook): fechas DD/MM/AAAA, claves SAT de forma de pago, «Clasificación presupuestal», saldos «(A favor)».
- **Saldos iniciales** (migración): adeudos y saldos a favor por unidad contra «Remanente de ejercicios anteriores», no como ingreso del año.

## Garantías de integridad
Importes en centavos enteros · partida doble validada · triggers que impiden editar o borrar lo contabilizado (solo contrapólizas) · meses cerrados bloqueados en la base · claves de idempotencia y llaves únicas contra duplicados (cuotas, pagos, clave de rastreo, UUID CFDI, movimientos bancarios) · quien captura un egreso no lo aprueba · bitácora encadenada por hash · respaldos AES-256-GCM verificados · sesiones de servidor, CSRF, 2FA TOTP, bloqueo por intentos, CSP estricta.

## Demostración en GitHub Pages
La carpeta `docs/` es una versión estática de solo lectura con datos ficticios (no necesita servidor).
1. Suba este repositorio a GitHub.
2. En **Settings → Pages**, elija *Deploy from a branch*, rama `main`, carpeta `/docs`.
3. Quedará en `https://<usuario>.github.io/<repositorio>/`.

Para regenerarla tras cambiar la interfaz: con el servidor demo corriendo, `node scripts/build-demo.mjs`.
La demo no guarda cambios; el sistema real (con base de datos y seguridad) corre con `node server/index.mjs`.
