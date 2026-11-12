// Pruebas de seguridad contra el servidor real por HTTP: robustez ante peticiones mal formadas, cabeceras,
// sesiones, CSRF, permisos por rol, aislamiento entre condominios, 2FA, contraseñas temporales y archivos.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servidor, crudo, Cliente, idem, PDF_B64 } from './apoyo.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'indiviso-seg-'));
process.env.INDIVISO_DATA = DATA;
const { openDb, tx } = await import('../server/db.mjs');
const F = await import('../server/finanzas.mjs');
const { hashPassword: hashNode, codigoTotp, verifyAuditChain } = await import('../server/security.mjs');
const apoyo = await import('./apoyo.mjs');
const hashPassword = apoyo.MOTOR === 'php' ? apoyo.hashPassword : hashNode;
const { apiRoutes } = await import('../server/api.mjs');
const { authRoutes } = await import('../server/auth.mjs');
const { hoy, addMonths, periodoDe, addDays } = await import('../server/util.mjs');

// ---------- Datos base: dos condominios con usuarios distintos ----------
const db = openDb();
const PASS = 'Clave-Segura-2026!';
const HASH = hashPassword(PASS);
const usuario = (email, nombre, superadmin = 0) => Number(db.prepare('INSERT INTO usuarios (email, nombre, pass_hash, superadmin, created_at, pass_cambiado_at) VALUES (?,?,?,?,?,?)').run(email, nombre, HASH, superadmin, Date.now(), Date.now()).lastInsertRowid);
const U = { sup: usuario('sup@t.test', 'Súper', 1), adminA: usuario('admina@t.test', 'Admin A'), adminB: usuario('adminb@t.test', 'Admin B'), contA: usuario('conta@t.test', 'Contador A'),
  comA: usuario('coma@t.test', 'Comité A'), resA: usuario('resa@t.test', 'Residente A'), multi: usuario('multi@t.test', 'Multi'), soloA: usuario('soloa@t.test', 'Solo A'),
  bloq: usuario('bloq@t.test', 'Bloqueable'), mfa: usuario('mfa@t.test', 'Con 2FA') };
const P1 = addMonths(periodoDe(hoy()), -1);
const condo = nombre => tx(db, () => F.crearCondominio(db, { nombre, umbral_aprobacion_cents: 500000, dia_vencimiento: 10 }, { id: U.sup }));
const A = condo('Condominio A'), B = condo('Condominio B');
const miembro = (uid, cid, rol, persona = null) => db.prepare('INSERT INTO membresias (usuario_id, condominio_id, rol, persona_id) VALUES (?,?,?,?)').run(uid, cid, rol, persona);
const unidad = (cid, clave) => Number(db.prepare("INSERT INTO unidades (condominio_id, clave, indiviso_ppm, cuota_cents, referencia, created_at) VALUES (?,?,500000,200000,?,0)").run(cid, clave, `REF${cid}${clave.replace('-', '')}`).lastInsertRowid);
const persona = (cid, nombre, uid) => { const id = Number(db.prepare('INSERT INTO personas (condominio_id, nombre, created_at) VALUES (?,?,0)').run(cid, nombre).lastInsertRowid); db.prepare("INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,'propietario')").run(uid, id); return id; };
const uA1 = unidad(A, 'A-1'), uA2 = unidad(A, 'A-2'), uB1 = unidad(B, 'B-1'), uB2 = unidad(B, 'B-2');
const perA1 = persona(A, 'Ana de A', uA1), perB1 = persona(B, 'Beto de B', uB1); persona(A, '=HYPERLINK("http://malo","clic")', uA2);
miembro(U.adminA, A, 'admin'); miembro(U.adminB, B, 'admin'); miembro(U.contA, A, 'contador'); miembro(U.comA, A, 'comite'); miembro(U.resA, A, 'residente', perA1);
miembro(U.multi, A, 'contador'); miembro(U.multi, B, 'admin'); miembro(U.soloA, A, 'contador'); miembro(U.bloq, A, 'contador'); miembro(U.mfa, A, 'contador');
const bancoA = tx(db, () => F.crearCuentaBanco(db, A, { nombre: 'Operación', banco: 'Banco A', numero: '1111222233' }));
const bancoB = tx(db, () => F.crearCuentaBanco(db, B, { nombre: 'Operación', banco: 'Banco B', numero: '9999888877' }));
for (const c of [A, B]) tx(db, () => F.emitirCuotas(db, c, P1, { id: U.sup }));
const partida = cid => db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5202'").get(cid).id;

const srv = await servidor(DATA);
after(async () => { await srv.parar(); db.close(); });
const entrar = async email => { const c = new Cliente(srv.url); const r = await c.login(email, PASS); assert.equal(r.status, 200, `login ${email}: ${r.text}`); return c; };
const adminA = await entrar('admina@t.test'), adminB = await entrar('adminb@t.test'), contA = await entrar('conta@t.test'), comA = await entrar('coma@t.test'), resA = await entrar('resa@t.test'), sup = await entrar('sup@t.test');
const a = p => `/api/c/${A}${p}`, b = p => `/api/c/${B}${p}`;

// Datos de B creados por su administrador (lo que A nunca debe alcanzar)
const IDB = {};
{
  IDB.archivo = (await adminB.ok('POST', b('/archivos'), { nombre: 'comprobante-b.pdf', base64: PDF_B64 })).id;
  IDB.proveedor = await adminB.ok('POST', b('/proveedores'), { nombre: 'Proveedor Secreto de B' });
  IDB.pago = (await adminB.ok('POST', b('/pagos'), { unidad_id: uB1, fecha: hoy(), monto_cents: 50000, metodo: 'transferencia', referencia: 'B-REF-1', cuenta_banco_id: bancoB, comprobante_id: IDB.archivo, idem_key: idem() })).id;
  IDB.egresoKey = idem();
  IDB.egreso = (await adminB.ok('POST', b('/egresos'), { proveedor_id: IDB.proveedor, cuenta_id: partida(B), fondo: 'operacion', fecha: hoy(), concepto: 'Limpieza B', subtotal_cents: 900000, iva_cents: 0, retenciones_cents: 0, idem_key: IDB.egresoKey })).id;
  IDB.cargo = db.prepare('SELECT id FROM cargos WHERE condominio_id = ? AND unidad_id = ?').get(B, uB2).id;
  await adminB.ok('POST', b(`/bancos/${bancoB}/importar`), { filas: [{ fecha: hoy(), descripcion: 'DEPOSITO X', referencia: 'ZZ1', cargo_cents: 0, abono_cents: 12345 }] });
  IDB.mov = db.prepare('SELECT id FROM banco_movs WHERE cuenta_banco_id = ?').get(bancoB).id;
  IDB.presupuesto = await adminB.ok('POST', b('/presupuestos'), { ejercicio: +hoy().slice(0, 4) });
  IDB.poliza = await adminB.ok('POST', b('/polizas'), { tipo: 'D', fecha: hoy(), concepto: 'Ajuste B', lineas: [{ cuenta: partida(B), debe: 1000, haber: 0 }, { cuenta: db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5590'").get(B).id, debe: 0, haber: 1000 }] });
  IDB.fondo = await adminB.ok('POST', b('/fondos'), { nombre: 'Fondo B' });
  IDB.recurrente = await adminB.ok('POST', b('/cargos-recurrentes'), { tipo: 'otro', concepto: 'Cajón', monto_cents: 50000, desde: periodoDe(hoy()) });
}
const huellaB = () => JSON.stringify([db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) s FROM polizas WHERE condominio_id = ?').get(B), db.prepare('SELECT COUNT(*) n FROM pagos WHERE condominio_id = ?').get(B),
  db.prepare('SELECT COUNT(*) n FROM egresos WHERE condominio_id = ?').get(B), db.prepare('SELECT COUNT(*) n FROM cargos WHERE condominio_id = ?').get(B), db.prepare('SELECT COUNT(*) n FROM aplicaciones WHERE condominio_id = ?').get(B),
  db.prepare('SELECT * FROM unidades WHERE condominio_id = ?').all(B), db.prepare('SELECT COUNT(*) n FROM encuesta_votos').get()]);

test('peticiones mal formadas no tumban el servidor', async () => {
  const h = { host: `127.0.0.1:${srv.port}` };
  for (const path of ['/%E0%A4%A', '/api/c/%E0%A4%A/tablero', '/api/auth/sesiones/%E0%A4%A/revocar', '/%', '/api/%', '/js/%FF%FE.js', '/a%00b.js']) {
    const r = await crudo(srv.port, { path, headers: h });
    assert.ok([400, 401, 404].includes(r.status), `${path} → ${r.status}`);
  }
  const post = await crudo(srv.port, { method: 'POST', path: '/api/auth/login', headers: { ...h, 'content-type': 'application/json' }, body: '{"email": "a@b.co", "password": ' });
  assert.equal(post.status, 400);
  assert.equal((await fetch(srv.url)).status, 200);
  assert.ok(srv.vivo(), 'el proceso sigue vivo');
});

test('cabeceras de seguridad en páginas y API', async () => {
  for (const p of ['/', '/api/auth/me']) {
    const r = await fetch(srv.url + p);
    const csp = r.headers.get('content-security-policy');
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(d), `CSP sin ${d}`);
    assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp), 'CSP sin orígenes externos ni inline');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('x-powered-by'), null);
  }
  assert.equal((await fetch(srv.url + '/api/auth/me')).headers.get('cache-control'), 'no-store');
});

test('solo se aceptan los nombres de host esperados (DNS rebinding)', async () => {
  assert.equal((await crudo(srv.port, { headers: { host: 'sitio-malicioso.example' } })).status, 421);
  assert.equal((await crudo(srv.port, { path: '/api/auth/me', headers: { host: `atacante.test:${srv.port}` } })).status, 421);
  assert.ok([400, 421].includes((await crudo(srv.port, { headers: {} })).status), 'sin Host');
  assert.equal((await crudo(srv.port, { headers: { host: `localhost:${srv.port}` } })).status, 200);
});

test('archivos estáticos: sin salir de public/ ni servir otros tipos', async () => {
  const h = { host: `127.0.0.1:${srv.port}` };
  for (const path of ['/../server/index.mjs', '/..%2f..%2fserver%2findex.mjs', '/%2e%2e/%2e%2e/server/db.mjs', '/js/../../server/db.mjs', '/js/..%2f..%2f..%2fdata%2findiviso.db', '/..%5c..%5cserver%5cdb.mjs',
    '/.gitignore', '/../README.md', '/../data/indiviso.db', '/js/ui.js.map', '/../package.json', '/....//....//server/index.mjs']) {
    const r = await crudo(srv.port, { path, headers: h });
    assert.ok(!/openDb|CREATE TABLE|createServer|SQLite format/.test(r.text), `${path} filtró contenido`);
    assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && r.text.includes('<div id="root">')), `${path} → ${r.status}`);
  }
  assert.equal((await crudo(srv.port, { method: 'POST', path: '/', headers: h })).status, 405);
  const js = await fetch(srv.url + '/js/app.js');
  assert.equal(js.status, 200);
  assert.equal((await fetch(srv.url + '/js/app.js', { headers: { 'if-none-match': js.headers.get('etag') } })).status, 304);
});

test('sin sesión, ninguna ruta privada responde datos', async () => {
  const anon = new Cliente(srv.url);
  let n = 0;
  for (const [method, path, opts] of [...authRoutes, ...apiRoutes]) {
    if (opts.publico) continue;
    const p = path.replace(':cid', A).replace(/:\w+/g, '1');
    const r = await anon.req(method, p, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${p} → ${r.status} ${r.text.slice(0, 80)}`);
    n++;
  }
  assert.ok(n > 120, `rutas probadas: ${n}`);
});

test('CSRF y origen: una petición de otro sitio no puede escribir', async () => {
  const body = { unidad_id: uA1, fecha: hoy(), monto_cents: 1000, metodo: 'efectivo', idem_key: idem() };
  assert.equal((await adminA.post(a('/pagos'), body, { csrf: false })).json.code, 'CSRF');
  assert.equal((await adminA.post(a('/pagos'), body, { csrf: false, headers: { 'x-csrf-token': 'x'.repeat(32) } })).json.code, 'CSRF');
  assert.equal((await adminA.post(a('/pagos'), body, { csrf: false, headers: { 'x-csrf-token': adminB.csrf } })).json.code, 'CSRF', 'el token de otra sesión no sirve');
  assert.equal((await adminA.post(a('/pagos'), body, { headers: { origin: 'https://sitio-malicioso.example' } })).json.code, 'ORIGEN');
  assert.equal((await adminA.post(a('/pagos'), body, { headers: { 'sec-fetch-site': 'cross-site' } })).json.code, 'ORIGEN');
  assert.equal((await adminA.get(a('/tablero'), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await adminA.post(a('/pagos'), JSON.stringify(body), { headers: { 'content-type': 'text/plain' } })).status, 415, 'solo JSON (un formulario de otro sitio no puede enviarlo)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pagos WHERE condominio_id = ?').get(A).n, 0);
  assert.equal((await adminA.post(a('/pagos'), body)).status, 200);
});

test('cuerpos inválidos: tamaño, formato y tipo', async () => {
  assert.equal((await adminA.post(a('/gestiones'), 'x'.repeat(1_100_000))).status, 413);
  assert.equal((await adminA.post(a('/gestiones'), '{mal json')).status, 400);
  assert.equal((await adminA.post(a('/gestiones'), '[1,2,3]')).status, 400);
  assert.equal((await adminA.post(a('/gestiones'), '"texto"')).status, 400);
  assert.equal((await adminA.post(a('/gestiones'), { unidad_id: uA1, tipo: 'llamada', nota: 'x', __proto__: { admin: true }, constructor: { prototype: { rol: 'admin' } } })).status, 200);
  assert.equal(({}).rol, undefined);
});

test('aislamiento: el administrador de A no alcanza nada de B', async () => {
  const antes = huellaB();
  // 1) Todas las rutas GET con el identificador de B
  for (const [method, path] of apiRoutes) {
    if (method !== 'GET' || !path.includes(':cid')) continue;
    const r = await adminA.get(path.replace(':cid', B).replace(/:\w+/g, '1'));
    assert.equal(r.status, 404, `GET ${path} en B → ${r.status}`);
  }
  // 2) Recursos de B pedidos a través de A
  const gets = [`/unidades/${uB1}`, `/estado-cuenta/${uB1}`, `/pagos/${IDB.pago}/recibo`, `/constancia/${uB1}`, `/archivos/${IDB.archivo}`, `/bancos/${bancoB}/movimientos`, `/banco-movs/${IDB.mov}/candidatos`,
    `/presupuestos/${IDB.presupuesto}`, `/polizas/${IDB.poliza}`, `/reportes/mayor?cuenta=${partida(B)}`];
  for (const p of gets) { const r = await adminA.get(a(p)); assert.equal(r.status, 404, `GET ${p} → ${r.status} ${r.text.slice(0, 100)}`); }
  for (const p of [`/recibos?unidad=${uB1}`, `/cargos?unidad=${uB1}`]) { const r = await adminA.get(a(p)); assert.deepEqual(r.json, [], `${p} no debe traer datos de B`); }
  const busca = (await adminA.get(a('/buscar?q=Secreto'))).json;
  assert.equal(busca.proveedores.length + busca.unidades.length + busca.personas.length + busca.egresos.length, 0);
  // 3) Escrituras que referencian recursos de B
  const pago = extra => ({ unidad_id: uA1, fecha: hoy(), monto_cents: 1000, metodo: 'transferencia', cuenta_banco_id: bancoA, idem_key: idem(), confirmar_duplicado: true, ...extra });
  const egreso = extra => ({ cuenta_id: partida(A), fondo: 'operacion', fecha: hoy(), concepto: 'x', subtotal_cents: 1000, iva_cents: 0, retenciones_cents: 0, idem_key: idem(), ...extra });
  const escrituras = [
    ['POST', '/pagos', pago({ unidad_id: uB1 }), 404], ['POST', '/pagos', pago({ cuenta_banco_id: bancoB }), 400], ['POST', '/pagos', pago({ comprobante_id: IDB.archivo }), 400],
    ['POST', `/pagos/${IDB.pago}/cancelar`, { motivo: 'x' }, 404], ['POST', `/pagos/${IDB.pago}/validar`, { aceptar: true }, 404],
    ['POST', '/egresos', egreso({ proveedor_id: IDB.proveedor }), 400], ['POST', '/egresos', egreso({ cuenta_id: partida(B) }), 400], ['POST', '/egresos', egreso({ comprobante_id: IDB.archivo }), 400],
    ['POST', '/egresos', egreso({ fondo: 'reserva', fondo_id: IDB.fondo }), 400], ['POST', '/egresos', egreso({ idem_key: IDB.egresoKey }), 409],
    ['POST', `/egresos/${IDB.egreso}/aprobar`, { aprobar: true }, 404], ['POST', `/egresos/${IDB.egreso}/pagar`, { fecha_pago: hoy(), metodo: 'efectivo' }, 404], ['POST', `/egresos/${IDB.egreso}/cancelar`, { motivo: 'x' }, 404],
    ['PUT', `/unidades/${uB1}`, { tipo: 'departamento', indiviso_ppm: 1, cuota_cents: 1, estado: 'ocupada', activo: false }, 404],
    ['POST', `/unidades/${uA1}/personas`, { persona_id: perB1, rol: 'propietario' }, 404], ['POST', `/unidades/${uB1}/personas`, { persona_id: perA1, rol: 'propietario' }, 404],
    ['PUT', `/personas/${perB1}`, { nombre: 'Hackeado' }, 404], ['POST', '/personas', { nombre: 'X', unidad_id: uB1 }, 404],
    ['POST', `/cargos/${IDB.cargo}/bonificar`, { monto_cents: 100, motivo: 'x' }, 404], ['POST', `/cargos/${IDB.cargo}/cancelar`, { motivo: 'x' }, 404],
    ['POST', '/cobranza/cargo', { unidad_id: uB1, tipo: 'multa', concepto: 'x', monto_cents: 100, fecha: hoy() }, 404],
    ['POST', '/cobranza/recargo-manual', { cargo_id: IDB.cargo, modo: 'monto', monto_cents: 100, fecha: hoy() }, 404],
    ['POST', '/cargos-recurrentes', { unidad_id: uB1, tipo: 'otro', concepto: 'x', monto_cents: 100, desde: periodoDe(hoy()) }, 404],
    ['POST', `/cargos-recurrentes/${IDB.recurrente}/desactivar`, {}, 404], ['POST', '/gestiones', { unidad_id: uB1, tipo: 'llamada', nota: 'x' }, 404],
    ['POST', '/convenios', { unidad_id: uB1, parcialidades: 3, fecha: hoy(), condonar_recargos: false }, 404],
    ['POST', `/bancos/${bancoB}/importar`, { filas: [{ fecha: hoy(), descripcion: 'x', cargo_cents: 0, abono_cents: 5 }] }, 404], ['POST', `/bancos/${bancoB}/autoconciliar`, {}, 404],
    ['POST', `/banco-movs/${IDB.mov}/conciliar`, { tipo: 'otro' }, 404], ['POST', `/banco-movs/${IDB.mov}/crear-pago`, { unidad_id: uA1 }, 404],
    ['PUT', `/presupuestos/${IDB.presupuesto}/lineas`, { lineas: [{ cuenta_id: partida(B), mes: 1, monto_cents: 5 }] }, 404], ['POST', `/presupuestos/${IDB.presupuesto}/aprobar`, { acta: 'x' }, 404],
    ['POST', '/polizas', { tipo: 'D', fecha: hoy(), concepto: 'x', lineas: [{ cuenta: partida(B), debe: 5, haber: 0 }, { cuenta: partida(A), debe: 0, haber: 5 }] }, 400],
    ['POST', `/polizas/${IDB.poliza}/revertir`, { motivo: 'x' }, 404], ['PUT', `/fondos/${IDB.fondo}`, { activo: false }, 404],
    ['PUT', `/usuarios/${U.adminB}`, { rol: 'residente', activo: true }, 404], ['POST', `/usuarios/${U.adminB}/restablecer`, {}, 404], ['POST', `/usuarios/${U.adminB}/restablecer-2fa`, {}, 404],
    ['POST', '/usuarios', { nombre: 'x', email: 'nuevo-res@t.test', rol: 'residente', persona_id: perB1 }, 404],
  ];
  for (const [m, p, body, esperado] of escrituras) {
    const r = await adminA.req(m, a(p), body);
    assert.equal(r.status, esperado, `${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  const imp = await adminA.post(a('/importar/pagos'), { filas: [['Unidad', 'Fecha', 'Importe'], ['B-1', hoy(), 500]], aplicar: true });
  assert.equal(imp.json?.resumen?.validas ?? 0, 0, 'importar no puede abonar a una unidad de B');
  assert.equal(huellaB(), antes, 'nada de B cambió');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pagos WHERE condominio_id = ? AND (comprobante_id = ? OR cuenta_banco_id = ?)").get(A, IDB.archivo, bancoB).n, 0);
});

test('permisos por rol', async () => {
  const eg = extra => ({ cuenta_id: partida(A), fondo: 'operacion', fecha: hoy(), concepto: 'Gasto de prueba', subtotal_cents: 900000, iva_cents: 0, retenciones_cents: 0, idem_key: idem(), ...extra });
  // Contador: captura, pero no aprueba, cancela, cierra ni configura
  const e1 = await contA.ok('POST', a('/egresos'), eg());
  assert.equal(e1.estado, 'por_aprobar');
  const pg = (await adminA.ok('GET', a('/pagos')))[0];
  for (const [m, p, body] of [['POST', `/egresos/${e1.id}/aprobar`, { aprobar: true }], ['POST', `/pagos/${pg.id}/cancelar`, { motivo: 'x' }], ['PUT', '/config', { nombre: 'x' }], ['POST', `/periodos/${P1}/cerrar`, {}],
    ['GET', '/usuarios'], ['GET', '/auditoria'], ['POST', '/usuarios', { nombre: 'x', email: 'x@t.test', rol: 'admin' }], ['PUT', '/logo', { nombre: 'l.png', base64: 'AAAA' }],
    ['POST', '/descuentos/lote', { periodo: P1, pct_bp: 1000, motivo: 'x' }], ['POST', '/cuentas', { codigo: '5999', nombre: 'x', tipo: 'egreso' }]]) {
    assert.equal((await contA.req(m, a(p), m === 'GET' ? undefined : body)).status, 403, `contador ${m} ${p}`);
  }
  // Comité: consulta y aprueba, no captura
  for (const [m, p, body] of [['POST', '/pagos', { unidad_id: uA1, fecha: hoy(), monto_cents: 100, metodo: 'efectivo', idem_key: idem() }], ['POST', '/egresos', eg()], ['POST', '/cobranza/emitir', { periodo: P1 }],
    ['POST', '/polizas', { tipo: 'D', fecha: hoy(), concepto: 'x', lineas: [] }], ['POST', '/importar/pagos', { filas: [['Unidad', 'Fecha', 'Importe'], ['A-1', hoy(), 5]], aplicar: true }], ['PUT', '/config', { nombre: 'x' }]]) {
    assert.equal((await comA.req(m, a(p), body)).status, 403, `comité ${m} ${p}`);
  }
  assert.equal((await comA.get(a('/auditoria'))).status, 200);
  // Segregación de funciones: quien captura no aprueba, aunque sea administrador
  const e2 = await adminA.ok('POST', a('/egresos'), eg());
  assert.equal((await adminA.post(a(`/egresos/${e2.id}/aprobar`), { aprobar: true })).json.code, 'SOD');
  assert.equal((await comA.post(a(`/egresos/${e2.id}/aprobar`), { aprobar: true })).status, 200);
  // Residente: solo su portal
  for (const p of ['/tablero', '/unidades', '/pagos', '/egresos', '/reportes/ingresos', '/buscar?q=ana', '/morosidad', '/config', '/personas', '/usuarios', '/auditoria', '/estados-cuenta', '/importar/catalogos', '/polizas'])
    assert.equal((await resA.get(a(p))).status, 403, `residente GET ${p}`);
  assert.equal((await resA.get(a('/mi'))).status, 200);
  assert.equal((await resA.get(a(`/estado-cuenta/${uA1}`))).status, 200);
  assert.equal((await resA.get(a(`/estado-cuenta/${uA2}`))).status, 404, 'no ve la unidad de su vecino');
  assert.equal((await resA.get(a(`/recibos?unidad=${uA2}`))).status, 404);
  assert.equal((await resA.get(a(`/pagos/${pg.id}/recibo`))).status, pg.unidad_id === uA1 ? 200 : 404);
  assert.equal((await resA.post(a('/mi/pagos'), { unidad_id: uA2, fecha: hoy(), monto_cents: 100, metodo: 'transferencia', idem_key: idem(), comprobante_id: 1 })).status, 404);
  assert.equal((await resA.post(a('/pagos'), { unidad_id: uA1, fecha: hoy(), monto_cents: 100, metodo: 'efectivo', idem_key: idem() })).status, 403);
  // Administración general: solo superadministrador
  for (const [m, p] of [['GET', '/api/admin/condominios'], ['GET', '/api/admin/usuarios'], ['GET', '/api/admin/auditoria'], ['GET', '/api/admin/estado'], ['GET', '/api/admin/respaldos'], ['POST', '/api/admin/respaldos'],
    ['POST', '/api/condominios'], ['PUT', `/api/admin/condominios/${B}`], ['PUT', `/api/admin/usuarios/${U.contA}`], ['POST', `/api/admin/usuarios/${U.contA}/restablecer`], ['POST', a(`/periodos/${P1}/reabrir`)], ['POST', a('/ejercicios/2020/reabrir')]])
    assert.equal((await adminA.req(m, p, m === 'GET' ? undefined : { activo: false, nombre: 'x', motivo: 'x' })).status, 403, `admin ${m} ${p}`);
  assert.equal((await sup.get('/api/admin/estado')).status, 200);
  assert.ok((await sup.ok('GET', '/api/admin/auditoria?seguridad=1')).some(x => x.accion === 'acceso_denegado'), 'los intentos sin permiso quedan en la bitácora');
});

test('bloqueo por intentos: mismo comportamiento exista o no la cuenta', async () => {
  const intentos = async email => { const c = new Cliente(srv.url); const out = []; for (let i = 0; i < 7; i++) out.push((await c.post('/api/auth/login', { email, password: 'Incorrecta-12345!' })).status); return out; };
  const existe = await intentos('bloq@t.test'), noExiste = await intentos('fantasma@t.test');
  assert.deepEqual(existe, [401, 401, 401, 401, 429, 429, 429], 'al quinto fallo la cuenta queda en pausa');
  assert.deepEqual(noExiste, existe, 'no se puede averiguar si un correo está registrado');
  const c = new Cliente(srv.url);
  assert.equal((await c.login('bloq@t.test', PASS)).status, 429, 'bloqueada aun con la contraseña correcta');
  // el administrador la desbloquea
  assert.equal((await adminA.post(a(`/usuarios/${U.bloq}/desbloquear`))).status, 200);
});

test('contraseña temporal: debe cambiarse antes de usar el sistema', async () => {
  const inv = await adminA.ok('POST', a('/usuarios'), { nombre: 'Nueva Contadora', email: 'nueva@t.test', rol: 'contador' });
  assert.ok(inv.password_temporal);
  const c = new Cliente(srv.url);
  const l = await c.login('nueva@t.test', inv.password_temporal);
  assert.equal(l.json.cambiar_password, true);
  assert.equal(c.me.condominios.length, 0);
  assert.equal((await c.get(a('/tablero'))).json.code, 'CAMBIO_PASSWORD');
  assert.equal((await c.post(a('/egresos'), {})).json.code, 'CAMBIO_PASSWORD');
  assert.equal((await c.post('/api/auth/password', { actual: inv.password_temporal, nueva: 'corta' })).status, 400);
  assert.equal((await c.post('/api/auth/password', { actual: inv.password_temporal, nueva: inv.password_temporal })).status, 400, 'no puede reutilizar la temporal');
  assert.equal((await c.post('/api/auth/password', { actual: inv.password_temporal, nueva: 'Otra-Clave-Larga-99' })).status, 200);
  assert.equal((await c.get(a('/tablero'))).status, 200);
  assert.equal((await new Cliente(srv.url).login('nueva@t.test', inv.password_temporal)).status, 401, 'la temporal ya no sirve');
  // Una temporal vencida no permite entrar
  const r = await adminA.ok('POST', a(`/usuarios/${inv.id}/restablecer`), {});
  db.prepare('UPDATE usuarios SET pass_temporal_hasta = ? WHERE id = ?').run(Date.now() - 1000, inv.id);
  assert.equal((await new Cliente(srv.url).login('nueva@t.test', r.password_temporal)).status, 401);
  assert.equal((await c.get(a('/tablero'))).status, 401, 'restablecer cierra las sesiones abiertas');
});

test('restablecer cuentas: solo las que el administrador controla por completo', async () => {
  assert.equal((await adminA.post(a(`/usuarios/${U.multi}/restablecer`))).status, 403, 'usuario con acceso a otro condominio');
  assert.equal((await adminA.post(a(`/usuarios/${U.multi}/restablecer-2fa`))).status, 403);
  assert.equal((await adminA.post(a(`/usuarios/${U.adminA}/restablecer`))).status, 400, 'no a sí mismo');
  db.prepare("INSERT INTO membresias (usuario_id, condominio_id, rol) VALUES (?,?,'comite')").run(U.sup, A);
  assert.equal((await adminA.post(a(`/usuarios/${U.sup}/restablecer`))).status, 403, 'nunca al superadministrador');
  db.prepare('DELETE FROM membresias WHERE usuario_id = ?').run(U.sup);
  const r = await adminA.ok('POST', a(`/usuarios/${U.soloA}/restablecer`), {});
  assert.equal((await new Cliente(srv.url).login('soloa@t.test', PASS)).status, 401, 'la anterior ya no sirve');
  assert.equal((await new Cliente(srv.url).login('soloa@t.test', r.password_temporal)).json.cambiar_password, true);
  assert.equal((await sup.post(`/api/admin/usuarios/${U.multi}/restablecer`)).status, 200, 'el superadministrador sí puede');
});

test('verificación en dos pasos: códigos de un solo uso y de respaldo', async () => {
  const c = await entrar('mfa@t.test');
  const ini = await c.ok('POST', '/api/auth/totp/iniciar', {});
  assert.notEqual(db.prepare('SELECT totp_secret s FROM usuarios WHERE id = ?').get(U.mfa).s, ini.secret, 'el secreto se guarda cifrado');
  assert.equal((await c.post('/api/auth/totp/activar', { code: '000000' })).status, 400);
  const act = await c.ok('POST', '/api/auth/totp/activar', { code: codigoTotp(ini.secret) });
  assert.equal(act.codigos.length, 10);
  // Nuevo inicio de sesión: sin segundo factor no hay acceso
  const d = new Cliente(srv.url);
  assert.equal((await d.login('mfa@t.test', PASS)).json.mfa, true);
  assert.equal((await d.get(a('/tablero'))).json.code, 'MFA');
  assert.equal(d.me.condominios.length, 0);
  assert.equal((await d.post('/api/auth/mfa', { code: '123456' })).status, 401);
  assert.equal((await d.post('/api/auth/mfa', { code: codigoTotp(ini.secret) })).status, 401, 'el código usado al activar no se puede repetir');
  assert.equal((await d.post('/api/auth/mfa', { code: act.codigos[0] })).status, 200, 'código de respaldo');
  await d.sesion();
  assert.equal((await d.get(a('/tablero'))).status, 200);
  const e = new Cliente(srv.url);
  await e.login('mfa@t.test', PASS);
  assert.equal((await e.post('/api/auth/mfa', { code: act.codigos[0] })).status, 401, 'un código de respaldo sirve una sola vez');
  assert.equal((await e.post('/api/auth/mfa', { code: codigoTotp(ini.secret, Date.now() + 30000) })).status, 200, 'código siguiente de la aplicación');
  // Desactivar exige contraseña y código
  await e.sesion();
  assert.equal((await e.post('/api/auth/totp/desactivar', { password: PASS, code: '111111' })).status, 401);
  assert.equal((await e.post('/api/auth/totp/desactivar', { password: PASS, code: act.codigos[1] })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM totp_respaldo WHERE usuario_id = ?').get(U.mfa).n, 0);
});

test('sesiones: cierre, expiración por inactividad y cambio de contraseña', async () => {
  const c = await entrar('conta@t.test'), d = await entrar('conta@t.test');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  // inactividad: 31 minutos sin uso
  db.prepare('UPDATE sesiones SET last_seen = ? WHERE usuario_id = ? AND revocada = 0').run(Date.now() - 31 * 60000, U.contA);
  assert.equal((await d.get('/api/auth/me')).status, 401);
  assert.equal((await contA.get('/api/auth/me')).status, 401);
  // cambiar la contraseña cierra las demás sesiones
  const x = await entrar('conta@t.test'), y = await entrar('conta@t.test');
  assert.equal((await x.post('/api/auth/password', { actual: 'no-es', nueva: 'Nueva-Clave-Larga-77' })).status, 401);
  assert.equal((await x.post('/api/auth/password', { actual: PASS, nueva: 'Nueva-Clave-Larga-77' })).status, 200);
  assert.equal((await y.get('/api/auth/me')).status, 401);
  assert.equal((await x.get('/api/auth/me')).status, 200);
  // la cookie es HttpOnly y SameSite=Strict
  const r = await fetch(srv.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'conta@t.test', password: 'Nueva-Clave-Larga-77' }) });
  const ck = r.headers.getSetCookie()[0];
  assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/); assert.match(ck, /Path=\//);
  // tope de sesiones simultáneas
  for (let i = 0; i < 10; i++) await new Cliente(srv.url).login('conta@t.test', 'Nueva-Clave-Larga-77');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ?').get(U.contA, Date.now()).n <= 8);
});

test('archivos: solo PDF/PNG/JPG/XML reales, descarga aislada', async () => {
  const sube = (nombre, contenido) => adminA.post(a('/archivos'), { nombre, base64: Buffer.from(contenido).toString('base64') });
  assert.equal((await sube('pagina.pdf', '<html><script>alert(1)</script></html>')).status, 415);
  assert.equal((await sube('imagen.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')).status, 415);
  assert.equal((await sube('programa.exe', 'MZ\u0090\u0000')).status, 415);
  assert.equal((await adminA.post(a('/archivos'), { nombre: 'x.pdf', base64: '%%%no-base64%%%' })).status, 400);
  const ok = await adminA.ok('POST', a('/archivos'), { nombre: '../../etc/passwd<script>.pdf', base64: PDF_B64 });
  const fila = db.prepare('SELECT nombre, sha256 FROM archivos WHERE id = ?').get(ok.id);
  assert.ok(!/[\/<>]/.test(fila.nombre), 'nombre saneado');
  assert.match(fila.sha256, /^[0-9a-f]{64}$/);
  const baja = await adminA.get(a(`/archivos/${ok.id}`));
  assert.match(baja.headers.get('content-disposition'), /^attachment/);
  assert.match(baja.headers.get('content-security-policy'), /sandbox/);
  assert.equal(baja.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await resA.get(a(`/archivos/${ok.id}`))).status, 404, 'un residente no descarga archivos ajenos');
  // logotipo: solo imagen
  assert.equal((await adminA.put(a('/logo'), { nombre: 'logo.pdf', base64: PDF_B64 })).status, 415);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await adminA.put(a('/logo'), { nombre: 'logo.png', base64: png.toString('base64') })).status, 200);
  const logo = await resA.get(a('/logo'));
  assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal((await adminB.get(b('/logo'))).status, 404);
});

test('entradas hostiles: inyección SQL, tipos y fórmulas en exportaciones', async () => {
  for (const p of [`/cargos?unidad=1%20OR%201=1`, `/pagos?desde=2020-01-01'%20OR%20'1'='1`, `/reportes/ingresos?anio=2026;DROP%20TABLE%20pagos`, `/polizas?periodo=2026-01'--`, `/auditoria?limit=1;--`, `/unidades/1%20OR%201=1`, `/morosidad?corte=hoy`])
    assert.equal((await adminA.get(a(p))).status, 400, p);
  const r = await adminA.get(a(`/buscar?q=${encodeURIComponent("' OR 1=1 --")}`));
  assert.equal(r.status, 200); assert.equal(r.json.unidades.length + r.json.personas.length + r.json.pagos.length, 0);
  assert.equal((await adminA.get(a(`/buscar?q=${encodeURIComponent('%')}%25`))).json.unidades.length, 0, 'los comodines se tratan como texto');
  assert.equal((await adminA.get(a('/polizas?q=' + encodeURIComponent("%' UNION SELECT pass_hash FROM usuarios --")))).status, 200);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM pagos").get().n > 0, 'las tablas siguen ahí');
  for (const body of [{ unidad_id: '1; DROP TABLE pagos', fecha: hoy(), monto_cents: 100, metodo: 'efectivo', idem_key: idem() }, { unidad_id: uA1, fecha: hoy(), monto_cents: -5, metodo: 'efectivo', idem_key: idem() },
    { unidad_id: uA1, fecha: hoy(), monto_cents: 1.5, metodo: 'efectivo', idem_key: idem() }, { unidad_id: uA1, fecha: '2026-02-31', monto_cents: 100, metodo: 'efectivo', idem_key: idem() },
    { unidad_id: uA1, fecha: addDays(hoy(), 2), monto_cents: 100, metodo: 'efectivo', idem_key: idem() }, { unidad_id: uA1, fecha: '1999-12-31', monto_cents: 100, metodo: 'efectivo', idem_key: idem() },
    { unidad_id: uA1, fecha: hoy(), monto_cents: 100, metodo: 'bitcoin', idem_key: idem() }, { unidad_id: uA1, fecha: hoy(), monto_cents: 1e15, metodo: 'efectivo', idem_key: idem() },
    { unidad_id: { $gt: 0 }, fecha: hoy(), monto_cents: 100, metodo: 'efectivo', idem_key: idem() }, { unidad_id: uA1, fecha: hoy(), monto_cents: 100, metodo: 'efectivo', idem_key: 'corta' }])
    assert.equal((await adminA.post(a('/pagos'), body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await adminA.post(a('/egresos'), { cuenta_id: partida(A), fondo: 'operacion', fecha: addDays(hoy(), 1), concepto: 'futuro', subtotal_cents: 100, iva_cents: 0, retenciones_cents: 0, idem_key: idem() })).status, 400);
  // Un nombre con fórmula no se ejecuta al abrir el CSV en Excel
  const csv = (await adminA.get(a('/export/cartera.csv'))).text;
  assert.ok(csv.includes(`"'=HYPERLINK`), 'la celda con fórmula queda como texto');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
});

test('la bitácora registra y su cadena sigue íntegra', async () => {
  const acciones = new Set(db.prepare('SELECT DISTINCT accion FROM auditoria').all().map(x => x.accion));
  for (const x of ['login', 'login_fallido', 'cuenta_bloqueada', 'acceso_denegado', 'usuario_invitado', 'password_restablecida', 'cambio_password', 'mfa_activado', 'mfa_codigo_respaldo_usado', 'mfa_desactivado', 'logo_actualizado', 'cuenta_desbloqueada'])
    assert.ok(acciones.has(x), `falta ${x} en la bitácora`);
  assert.ok(!JSON.stringify(db.prepare("SELECT detalle FROM auditoria WHERE detalle IS NOT NULL").all()).includes(PASS), 'ninguna contraseña en la bitácora');
  assert.equal(verifyAuditChain(db).ok, true);
  assert.equal((await sup.ok('GET', '/api/admin/auditoria/verificar')).ok, true);
});

test('límite de frecuencia por conexión', async () => {
  const s2 = await servidor(DATA, { INDIVISO_RATE: '25' });
  try {
    const st = [];
    for (let i = 0; i < 30; i++) st.push((await fetch(s2.url + '/api/auth/me')).status);
    assert.equal(st.filter(x => x === 401).length, 25);
    assert.equal(st.filter(x => x === 429).length, 5);
    assert.equal((await fetch(s2.url + '/')).status, 200, 'las páginas no cuentan');
    // intentos fallidos de acceso por conexión
    const s3 = await servidor(DATA);
    try {
      let ultimo = 0;
      for (let i = 0; i < 32; i++) ultimo = (await new Cliente(s3.url).post('/api/auth/login', { email: `nadie${i}@t.test`, password: 'Incorrecta-12345!' })).status;
      assert.equal(ultimo, 429);
      assert.equal((await new Cliente(s3.url).login('admina@t.test', PASS)).status, 429, 'la conexión queda en pausa');
    } finally { await s3.parar(); }
  } finally { await s2.parar(); }
});
