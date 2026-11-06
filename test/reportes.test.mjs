// Pruebas de reportes por periodo (ingresos, egresos, bancos, conciliación), estado de cuenta detallado,
// recargos por porcentaje de cuota o monto fijo, y filas de ejemplo de las plantillas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INDIVISO_DATA = mkdtempSync(join(tmpdir(), 'indiviso-rep-'));
const { openDb, tx } = await import('../server/db.mjs');
const F = await import('../server/finanzas.mjs');
const R = await import('../server/reportes.mjs');
const { importar } = await import('../server/importar.mjs');
const { referenciaPago } = await import('../server/api.mjs');
const { hoy, periodoDe, addMonths, finDeMes } = await import('../server/util.mjs');

const db = openDb();
const P = periodoDe(hoy()), P1 = addMonths(P, -1), P2 = addMonths(P, -2);
const u1 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('r1@t.test','A','x',0)").run().lastInsertRowid) };
const cid = tx(db, () => F.crearCondominio(db, { nombre: 'Reportes', umbral_aprobacion_cents: 10000000, dias_gracia: 0, dia_vencimiento: 5 }, u1));
const banco = tx(db, () => F.crearCuentaBanco(db, cid, { nombre: 'Op', banco: 'Banco', numero: '1234567890' }));
const ins = clave => Number(db.prepare("INSERT INTO unidades (condominio_id, clave, indiviso_ppm, cuota_cents, referencia, created_at) VALUES (?, ?, 500000, 200000, ?, 0)").run(cid, clave, 'R' + clave).lastInsertRowid);
const ua = ins('R-1'), ub = ins('R-2');
let k = 0;
const pagar = (unidad, monto, fecha) => tx(db, () => F.registrarPago(db, cid, { unidad_id: unidad, fecha, monto_cents: monto, metodo: 'transferencia', referencia: 'RP' + (++k), cuenta_banco_id: banco, idem_key: 'REPKEY' + k, confirmar_duplicado: true }, u1));
const PERMS = { ver: ['admin'], capturar: ['admin'], config: ['admin'] };
const imp = (tipo, filas, aplicar = true, opciones = {}) => importar({ db, cid, user: u1, rol: 'admin', ip: '127.0.0.1' }, tipo, { filas, aplicar, opciones }, { perms: PERMS, rolPuede: () => true, referenciaPago });

test('ingresos: lo cobrado se clasifica por lo que pagó y cuadra con los pagos', () => {
  tx(db, () => F.emitirCuotas(db, cid, P2, u1));
  tx(db, () => F.emitirExtraordinaria(db, cid, { concepto: 'Impermeabilización', total_cents: 100000, metodo: 'igual', destino: 'reserva', fecha: `${P2}-02`, vencimiento: `${P2}-20` }, u1));
  pagar(ua, 250000, `${P2}-10`);               // cuota completa + extraordinaria completa
  pagar(ub, 300000, `${P2}-12`);               // cuota + extraordinaria + 50,000 a favor
  const r = R.ingresos(db, cid, `${P2}-01`, finDeMes(P2));
  const g = Object.fromEntries(r.grupos.map(x => [x.clave, x.total]));
  assert.equal(r.cobrado, 550000);
  assert.equal(r.total, 550000, 'el total del reporte es lo cobrado');
  assert.equal(g.ordinarios, 400000);
  assert.equal(g.extraordinarios, 100000);
  assert.equal(g.pendientes, 50000, 'el excedente queda como pendiente de aplicar');
  const m = R.ingresosMensual(db, cid, +P2.slice(0, 4)).meses.find(x => x.periodo === P2);
  assert.equal(m.total, 550000);
  assert.equal(Object.values(m.clasificaciones).reduce((a, b) => a + b, 0), 550000);
});

test('egresos del periodo: ordinarios y extraordinarios por clasificación', () => {
  const gasto = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5202'").get(cid).id;
  const e = tx(db, () => F.crearEgreso(db, cid, { cuenta_id: gasto, fondo: 'operacion', fecha: `${P2}-15`, concepto: 'Limpieza', subtotal_cents: 80000, iva_cents: 0, retenciones_cents: 0, idem_key: 'repegr0001' }, u1));
  tx(db, () => F.pagarEgreso(db, cid, e.id, { fecha_pago: `${P2}-16`, metodo: 'transferencia', cuenta_banco_id: banco }, u1));
  const r = R.egresosReporte(db, cid, `${P2}-01`, finDeMes(P2));
  assert.equal(r.total, 80000);
  assert.equal(r.grupos.find(x => x.clave === 'ordinarios').clasificaciones[0].nombre, '5202 · Limpieza');
  assert.equal(r.pagado, 80000);
});

test('saldos bancarios y conciliación al corte', () => {
  const s = R.saldosBancarios(db, cid, P2, P2);
  const b = s.cuentas.find(x => x.id === banco);
  assert.equal(b.ingresos, 550000);
  assert.equal(b.egresos, 80000);
  assert.equal(b.final, b.anterior + 470000);
  tx(db, () => F.importarMovimientosBanco(db, cid, banco, [
    { fecha: `${P2}-10`, descripcion: 'SPEI RR-1', referencia: 'RP1', cargo_cents: 0, abono_cents: 250000 },
    { fecha: `${P2}-20`, descripcion: 'COMISION', referencia: null, cargo_cents: 1500, abono_cents: 0 }], u1));
  const c = R.conciliacion(db, cid, P2, P2).cuentas.find(x => x.id === banco);
  assert.equal(c.sin_estado, undefined);
  assert.equal(c.depositos_transito, 300000, 'el pago de R-2 está en libros pero no en el banco');
  assert.equal(c.cargos_no_registrados, 1500, 'la comisión está en el banco pero no en libros');
  assert.equal(c.diferencia, 0, 'con las partidas en tránsito la conciliación cuadra');
});

test('estado de cuenta: una fila por cuota con su estatus y por pago con su recibo', () => {
  const d = R.estadoCuenta(db, cid, ub, `${P2}-01`, hoy());
  const cuota = d.movimientos.find(m => m.tipo === 'cuota');
  assert.equal(cuota.estatus, 'pagada');
  const pago = d.movimientos.find(m => m.tipo === 'pago');
  assert.ok(pago.recibo && pago.pago_id);
  assert.match(pago.concepto, /Cuota ordinaria/);
  assert.equal(d.totales.pagos, 300000);
  assert.equal(d.saldo_final, -50000);
  assert.equal(d.saldo_favor, 50000);
});

test('recargos: porcentaje sobre cada cuota, monto fijo y recargo manual a una cuota', () => {
  tx(db, () => F.emitirCuotas(db, cid, P1, u1)); // dos cuotas de 2,000 vencen el día 5 de P1
  db.prepare("UPDATE condominios SET recargo_modo = 'cuota', tasa_recargo_bp = 1000 WHERE id = ?").run(cid);
  const r = tx(db, () => F.calcularRecargos(db, cid, P, u1));
  assert.equal(r.emitidos, 2, 'las dos unidades tienen su cuota vencida');
  assert.equal(r.total, 40000, '10% de cada cuota de 2,000');
  db.prepare("UPDATE condominios SET recargo_modo = 'fijo', recargo_fijo_cents = 15000 WHERE id = ?").run(cid);
  assert.equal(tx(db, () => F.calcularRecargos(db, cid, P, u1)).emitidos, 0, 'un recargo por unidad y mes');
  const cuota = db.prepare("SELECT id FROM cargos WHERE unidad_id = ? AND tipo = 'ordinaria' AND periodo = ?").get(ua, P1).id;
  const m = tx(db, () => F.recargoManual(db, cid, { cargo_id: cuota, modo: 'porcentaje', porcentaje_bp: 500, fecha: hoy() }, u1));
  assert.equal(m.monto, 10000);
  assert.throws(() => tx(db, () => F.recargoManual(db, cid, { cargo_id: cuota, modo: 'monto', monto_cents: 5000, fecha: hoy() }, u1)), /ya tiene un recargo/);
  const d = R.estadoCuenta(db, cid, ua, `${P1}-01`, hoy());
  assert.equal(d.totales.penalidades, 30000);
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('plantillas: las filas de ejemplo no se importan; egresos con columnas de Vivook', () => {
  const cod = db.prepare('SELECT k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id WHERE b.id = ?').get(banco).codigo;
  const f = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const filas = [
    ['Concepto', 'Proveedor', 'Importe', 'Fecha', 'Forma de pago', 'Cuenta bancaria', 'Referencia', 'Clasificación presupuestal', 'Fondo', 'Comentarios'],
    ['1ra quincena de vigilancia', 'Seguridad', 15650, f(hoy()), 'Transferencia', cod, 'X1', '5201', 'Operación', 'EJEMPLO · borre esta fila'],
    ['Luz', 'CFE', 2563.5, f(hoy()), 'Transferencia', cod, 'CFE1', '5101 · Energía eléctrica', 'Operación', ''],
    ['Bomba', 'Hidráulica', '1,200.00', f(hoy()), 'Efectivo', 'Caja', '', 'Equipos hidráulicos y bombas', 'Extraordinario', 'urgente'],
  ];
  const r = imp('egresos', filas, true);
  assert.equal(r.resumen.ejemplos, 1);
  assert.equal(r.resumen.validas, 2, JSON.stringify(r.filas));
  const es = db.prepare("SELECT concepto, total_cents, estado, fondo FROM egresos WHERE condominio_id = ? AND concepto LIKE 'Luz%' OR concepto LIKE 'Bomba%' ORDER BY id").all(cid);
  assert.deepEqual(es.map(e => [e.total_cents, e.fondo]), [[256350, 'operacion'], [120000, 'reserva']]);
  assert.equal(es[0].estado, 'pagado');
  assert.throws(() => imp('egresos', filas.slice(0, 2), false), /solo trae las filas de ejemplo/);
});
