// Pruebas de pronto pago, adeudos recurrentes, fondos, cuentas por pagar, liquidación anual y encuestas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INDIVISO_DATA = mkdtempSync(join(tmpdir(), 'indiviso-mod-'));
const { openDb, tx } = await import('../server/db.mjs');
const F = await import('../server/finanzas.mjs');
const R = await import('../server/reportes.mjs');
const { resultadosEncuesta } = await import('../server/comunidad.mjs');
const { hoy, periodoDe, addMonths } = await import('../server/util.mjs');

const db = openDb();
const P = periodoDe(hoy());
const u1 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('m1@t.test','A','x',0)").run().lastInsertRowid) };
const u2 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('m2@t.test','B','x',0)").run().lastInsertRowid) };
const cid = tx(db, () => F.crearCondominio(db, { nombre: 'Módulos', umbral_aprobacion_cents: 10000000 }, u1));
const banco = tx(db, () => F.crearCuentaBanco(db, cid, { nombre: 'Op', banco: 'Banco', numero: '1234567890' }));
const ins = (clave, ind) => Number(db.prepare("INSERT INTO unidades (condominio_id, clave, indiviso_ppm, cuota_cents, referencia, created_at) VALUES (?, ?, ?, 100000, ?, 0)").run(cid, clave, ind, 'R' + clave).lastInsertRowid);
const ua = ins('M-1', 600000), ub = ins('M-2', 400000);
const gasto = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5302'").get(cid).id;
let k = 0;
const pagar = (unidad, monto, fecha) => tx(db, () => F.registrarPago(db, cid, { unidad_id: unidad, fecha, monto_cents: monto, metodo: 'transferencia', referencia: 'M' + (++k), cuenta_banco_id: banco, idem_key: 'MODKEY' + k, confirmar_duplicado: true }, u1));
const saldo = u => R.carteraUnidades(db, cid).find(x => x.id === u);

test('cargos recurrentes se emiten con la cuota y no se duplican', () => {
  tx(db, () => F.crearCargoRecurrente(db, cid, { unidad_id: ua, tipo: 'otro', concepto: 'Cajón adicional', monto_cents: 50000, desde: addMonths(P, -1), hasta: null }, u1));
  tx(db, () => F.crearCargoRecurrente(db, cid, { unidad_id: null, tipo: 'extraordinaria', concepto: 'Subsidio', monto_cents: 10000, desde: P, hasta: P }, u1));
  const a = tx(db, () => F.emitirCuotas(db, cid, P, u1));
  assert.equal(a.emitidos, 5); // 2 ordinarias + cajón + 2 subsidios
  assert.equal(tx(db, () => F.emitirCuotas(db, cid, P, u1)).emitidos, 0);
  assert.equal(saldo(ua).adeudo, 100000 + 50000 + 10000);
});

test('descuento por pronto pago: solo si el pago llega a tiempo y alcanza', () => {
  db.prepare('UPDATE condominios SET pronto_pago_bp = 500, pronto_pago_dia = 28 WHERE id = ?').run(cid); // 5% hasta el día 28
  const sinDesc = saldo(ub).adeudo; // 100000 + 10000
  const r = pagar(ub, sinDesc - 5000, `${P}-01`); // paga la cuota menos 5%
  assert.equal(r.descuento, 5000);
  assert.equal(saldo(ub).adeudo, 0);
  // fuera de plazo no hay descuento
  db.prepare('UPDATE condominios SET pronto_pago_dia = 1 WHERE id = ?').run(cid);
  const r2 = pagar(ua, 1000, `${P}-02`);
  assert.equal(r2.descuento, 0);
  db.prepare('UPDATE condominios SET pronto_pago_bp = 0, pronto_pago_dia = 0 WHERE id = ?').run(cid);
  const d = R.descuentos(db, cid, `${P}-01`, hoy());
  assert.equal(d.total, 5000);
  assert.equal(d.por_tipo[0].tipo, 'Pronto pago');
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('fondo específico: recibe la extraordinaria, paga su egreso y la cancelación regresa a su fondo', () => {
  const fid = tx(db, () => F.crearFondo(db, cid, { nombre: 'Pintura', meta_cents: 1000000 }, u1));
  tx(db, () => F.emitirExtraordinaria(db, cid, { concepto: 'Pintura de fachada', total_cents: 500000, metodo: 'indiviso', destino: 'fondo', fondo_id: fid, fecha: hoy(), vencimiento: hoy() }, u1));
  const f = () => R.fondos(db, cid, `${P}`, P).fondos.find(x => x.id === fid);
  assert.equal(f().aportaciones, 500000);
  assert.equal(R.fondos(db, cid, P, P).fondos[0].aportaciones, 20000, 'la reserva solo recibe el 10% de las cuotas ordinarias, no la extraordinaria');
  const e = tx(db, () => F.crearEgreso(db, cid, { cuenta_id: gasto, fondo: 'reserva', fondo_id: fid, fecha: hoy(), concepto: 'Pintor', subtotal_cents: 200000, iva_cents: 0, retenciones_cents: 0, idem_key: 'egrfondo01' }, u1));
  assert.equal(e.estado, 'por_aprobar', 'todo uso de fondo requiere aprobación');
  tx(db, () => F.aprobarEgreso(db, cid, e.id, true, null, u2));
  assert.equal(f().saldo, 300000);
  assert.equal(R.cuentasPorPagar(db, cid).totales.total, 200000);
  const ext = db.prepare("SELECT id FROM cargos WHERE condominio_id = ? AND tipo = 'extraordinaria' AND fondo_cuenta_id IS NOT NULL AND unidad_id = ?").get(cid, ua);
  tx(db, () => F.cancelarCargo(db, cid, ext.id, 'error', u1));
  assert.equal(f().saldo, 0, 'la cancelación descuenta del fondo correcto');
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('liquidación anual: emitido, pagado y saldo por unidad y mes', () => {
  const l = R.liquidacionAnual(db, cid, +hoy().slice(0, 4));
  const b = l.unidades.find(u => u.id === ub);
  assert.equal(b.meses[P].estado, 'parcial', 'pagó la cuota, falta la extraordinaria del mismo mes');
  assert.equal(b.saldo, 200000, 'solo queda su parte de la extraordinaria');
  assert.equal(l.totales.emitido, l.unidades.reduce((a, u) => a + u.emitido, 0));
});

test('encuestas: un voto por unidad, inmutable, resultados ponderados por indiviso', () => {
  const eid = Number(db.prepare("INSERT INTO encuestas (condominio_id, pregunta, cierra, ponderada, created_at) VALUES (?, '¿Pintar de blanco?', ?, 1, 0)").run(cid, hoy()).lastInsertRowid);
  const si = Number(db.prepare("INSERT INTO encuesta_opciones (encuesta_id, texto, orden) VALUES (?, 'Sí', 1)").run(eid).lastInsertRowid);
  db.prepare("INSERT INTO encuesta_opciones (encuesta_id, texto, orden) VALUES (?, 'No', 2)").run(eid);
  db.prepare('INSERT INTO encuesta_votos (encuesta_id, unidad_id, opcion_id, created_at) VALUES (?,?,?,0)').run(eid, ua, si);
  assert.throws(() => db.prepare('INSERT INTO encuesta_votos (encuesta_id, unidad_id, opcion_id, created_at) VALUES (?,?,?,0)').run(eid, ua, si), /UNIQUE|PRIMARY/);
  assert.throws(() => db.prepare('DELETE FROM encuesta_votos WHERE encuesta_id = ?').run(eid), /INMUTABLE/);
  const r = resultadosEncuesta(db, { id: eid, condominio_id: cid });
  assert.equal(r.emitidos, 1); assert.equal(r.opciones[0].indiviso_ppm, 600000); assert.equal(r.participacion, 0.5);
});

test('las columnas nuevas se agregan a una base existente', () => {
  const cols = t => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r => r.name);
  assert.ok(cols('condominios').includes('pronto_pago_bp'));
  assert.ok(cols('cargos').includes('fondo_cuenta_id'));
  assert.ok(cols('egresos').includes('fondo_id'));
});
