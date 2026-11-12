# Indiviso CMS — gestión financiera condominal

Node 24 + SQLite embebido (`node:sqlite`), sin dependencias externas.

## Abrir con doble clic
Instale Node.js LTS y abra **«Abrir Indiviso.command»** (Mac; la primera vez: clic derecho → Abrir) o **«Abrir Indiviso (Windows).bat»**. Crea los datos de demostración en `~/Indiviso-datos`, arranca el servidor y abre http://localhost:4300. Detalles en «LEEME - Como abrir.txt».

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
- Cada sección ofrece una **plantilla .xlsx** con hojas de catálogos (unidades, cuentas, partidas, formas de pago) y **3 filas de ejemplo en amarillo** («EJEMPLO · borre esta fila») que muestran cómo capturar y nunca se importan. El directorio y el presupuesto se exportan y se vuelven a importar ya editados.
- La plantilla de **egresos** usa las mismas columnas que Vivook: Concepto, Proveedor, Importe, Fecha, Forma de pago, Cuenta bancaria, Referencia, Clasificación presupuestal, Fondo y Comentarios.
- Antes de guardar se muestra una **vista previa validada fila por fila** por el mismo motor que la captura manual; las filas con error no se importan y se pueden descargar para corregirlas.
- Reimportar el mismo archivo **no duplica** pagos ni egresos. Acepta encabezados y formatos de otros sistemas (p. ej. Vivook): fechas DD/MM/AAAA, claves SAT de forma de pago, «Clasificación presupuestal», saldos «(A favor)».
- **Saldos iniciales** (migración): adeudos y saldos a favor por unidad contra «Remanente de ejercicios anteriores», no como ingreso del año.

## Módulos adicionales
- **Descuento por pronto pago** (Configuración): porcentaje automático a quien liquida su cuota a más tardar el día indicado; también descuentos por lote. Todo queda en *Cobranza → Descuentos*.
- **Adeudos recurrentes** (*Cobranza*): cargos fijos mensuales (cajón, bodega, extraordinaria en mensualidades) que se emiten con la cuota ordinaria.
- **Fondos** (Configuración y *Reportes → Fondos*): además del fondo de reserva, fondos para proyectos que reciben cuotas extraordinarias y pagan sus egresos con aprobación.
- **Cuentas por pagar** (*Egresos*): saldo con proveedores por antigüedad (0-30, 31-60, 61-90, +90 días).
- **Liquidación anual** (*Reportes*): cada unidad, mes por mes, emitido contra pagado; exportable a Excel.
- **Comunidad**: avisos, calendario, documentos, encuestas (un voto por unidad, opcionalmente ponderado por indiviso), teléfonos útiles y cosas perdidas; los residentes lo ven en su portal.

## Reportes en PDF y periodos
- Todo se consulta por **mes y año** (o «Todo el año»): ingresos, egresos, pagos, bancos, cuentas por cobrar, morosidad y estados financieros.
- **Ingresos** (menú *Cobranza*): todo lo cobrado mes con mes, clasificado en ordinarios, extraordinarios, otros y pendientes de aplicar (saldo a favor), con detalle por clasificación y concepto.
- **Reportes en PDF con gráficas** (*Reportes*): ingresos, egresos, cuentas por cobrar, saldos bancarios, conciliación bancaria y morosidad. Se generan en el navegador, sin dependencias.
- **Estados de cuenta**: anual, mensual, histórico o personalizado; cada cuota con su estatus (pagada, pago parcial, no pagada), recibo PDF de cada pago, todos los recibos juntos, aviso de cobro y estado de cuenta en PDF, individual o de todas las unidades.
- **Recargos** (Configuración): porcentaje sobre cada cuota vencida, porcentaje sobre el saldo vencido o monto fijo por cuota; además, recargo manual a una cuota desde el estado de cuenta.

## Seguridad
- Contraseñas con scrypt, sesiones de servidor (30 min de inactividad, 12 h máximo, tope de 8 por usuario), CSRF, cookies HttpOnly y SameSite estrictas.
- Verificación en dos pasos con secreto cifrado en reposo y 10 códigos de respaldo de un solo uso.
- Bloqueo por intentos fallidos por cuenta y por conexión sin revelar si un correo existe; límite de frecuencia general.
- Contraseñas temporales que vencen en 7 días y deben cambiarse al entrar.
- Lista de hosts permitidos (`INDIVISO_HOSTS`), CSP sin orígenes externos, aislamiento total entre condominios y bitácora de accesos denegados.
- `npm test` ejecuta 56 pruebas, incluidas las de seguridad por HTTP y tres condominios operando a la vez con todos los reportes cuadrados contra el libro.

## Agregar paneles
Ver [AGREGAR-PANELES.md](AGREGAR-PANELES.md): un archivo de pantalla y una línea en el registro `MODULOS`.

## Garantías de integridad
Importes en centavos enteros · partida doble validada · triggers que impiden editar o borrar lo contabilizado (solo contrapólizas) · meses cerrados bloqueados en la base · claves de idempotencia y llaves únicas contra duplicados (cuotas, pagos, clave de rastreo, UUID CFDI, movimientos bancarios) · quien captura un egreso no lo aprueba · bitácora encadenada por hash · respaldos AES-256-GCM verificados · sesiones de servidor, CSRF, 2FA TOTP, bloqueo por intentos, CSP estricta.

## Demostración en GitHub Pages
La carpeta `docs/` es una versión estática de solo lectura con datos ficticios (no necesita servidor).
1. Suba este repositorio a GitHub.
2. En **Settings → Pages**, elija *Deploy from a branch*, rama `main`, carpeta `/docs`.
3. Quedará en `https://<usuario>.github.io/<repositorio>/`.

Para regenerarla tras cambiar la interfaz: con el servidor demo corriendo, `node scripts/build-demo.mjs`.
La demo no guarda cambios; el sistema real (con base de datos y seguridad) corre con `node server/index.mjs`.
