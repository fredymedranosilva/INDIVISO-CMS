# Cómo agregar un panel nuevo

Indiviso es el esqueleto del panel administrativo: cada sección es un módulo independiente.

1. **Pantalla.** Cree `public/js/views/<id>.js` con `export async function render(el, ctx)`.
   Use `capi('/ruta')` para leer datos del condominio activo y los componentes de `ui.js`
   (`tabla`, `dialogo`, `dona`, `selectorPeriodo`, `toast`…). Las acciones de los botones se declaran con
   `ctx.acciones({ nombre: fn })` y `data-action="nombre"`.
2. **Menú.** Agregue una línea a `MODULOS` en `public/js/app.js`:
   `{ id, titulo, grupo, icono, perm, cargar: () => import('./views/<id>.js') }`.
   El menú, el enrutador y los permisos se arman solos.
3. **Servidor.** Agregue sus rutas al arreglo `apiRoutes` en `server/api.mjs` (o en un archivo propio, como
   `server/importar.mjs`) con la forma `['GET', `${C}/mi-ruta`, { perm: 'ver' }, ctx => ...]`.
   Toda ruta bajo `/api/c/:cid` ya valida sesión, 2FA, CSRF, membresía y permiso; filtre siempre por `ctx.cid`
   y use `escribir(ctx, accion, entidad, fn)` para que cada cambio quede en la bitácora dentro de una transacción.
4. **Tablas.** Agregue `CREATE TABLE IF NOT EXISTS` al esquema de `server/db.mjs` (con `condominio_id`) y, para
   columnas nuevas en tablas existentes, una línea en `COLUMNAS`: las bases ya instaladas se actualizan solas.
5. **Pruebas.** `npm test`. Agregue sus rutas a `test/seguridad.test.mjs` si exponen datos: la prueba de
   aislamiento verifica que un condominio nunca alcance datos de otro.
