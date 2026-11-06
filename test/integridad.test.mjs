// Pruebas de las garantías de integridad. Ejecutar: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INDIVISO_DATA = mkdtempSync(join(tmpdir(), 'indiviso-test-'));
const { openDb, tx } = await import('../server/db.mjs');
const F = await import('../server/finanzas.mjs');
const R = await import('../server/reportes.mjs');
const S = await import('../server/security.mjs');
const B = await import('../server/backup.mjs');
const { hoy, periodoDe, addMonths } = await import('../server/util.mjs');

const db = openDb();
const P = periodoDe(hoy());
const ANT = addMonths(P, -1);
const u1 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('a@t.test','A','x',0)").run().lastInsertRowid) };
const u2 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('b@t.test','B','x',0)").run().lastInsertRowid) };
const cid = tx(db, () => F.crearCondominio(db, { nombre: 'Prueba', umbral_aprobacion_cents: 500000 }, u1));
const banco = tx(db, () => F.crearCuentaBanco(db, cid, { nombre: 'Op', banco: 'Banco', numero: '1234567890' }));
const unidad = Number(db.prepare("INSERT INTO unidades (condominio_id, clave, indiviso_ppm, cuota_cents, referencia, created_at) VALUES (?, 'A-1', 500000, 300000, 'REF1', 0)").run(cid).lastInsertRowid);
db.prepare("INSERT INTO unidades (condominio_id, clave, indiviso_ppm, cuota_cents, referencia, created_at) VALUES (?, 'A-2', 500000, 300000, 'REF2', 0)").run(cid);
const gasto = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5202'").get(cid).id;
const pago = (o = {}) => ({ unidad_id: unidad, fecha: hoy(), monto_cents: 300000, metodo: 'transferencia', referencia: 'R' + Math.random(), cuenta_banco_id: banco, idem_key: 'K' + String(Math.random()).slice(2, 14), confirmar_duplicado: true, ...o });

test('póliza descuadrada se rechaza', () => {
  assert.throws(() => tx(db, () => F.crearPoliza(db, cid, { fecha: hoy(), concepto: 'x', origen: 'manual', lineas: [{ cuenta: gasto, debe: 100 }, { cuenta: F.cuenta(db, cid, 'CAJA'), haber: 99 }] }, u1)), /descuadrada/);
});

test('emitir dos veces el mismo mes no duplica cuotas', () => {
  const a = tx(db, () => F.emitirCuotas(db, cid, ANT, u1));
  const b = tx(db, () => F.emitirCuotas(db, cid, ANT, u1));
  assert.equal(a.emitidos, 2); assert.equal(b.emitidos, 0);
});

test('reintento con la misma clave de operación no duplica el pago', () => {
  const d = pago();
  const a = tx(db, () => F.registrarPago(db, cid, d, u1));
  const b = tx(db, () => F.registrarPago(db, cid, d, u1));
  assert.equal(a.id, b.id); assert.ok(b.repetido);
});

test('misma clave de rastreo e importe se rechaza', () => {
  tx(db, () => F.registrarPago(db, cid, pago({ referencia: 'RASTREO-1' }), u1));
  assert.throws(() => tx(db, () => F.registrarPago(db, cid, pago({ referencia: 'RASTREO-1' }), u1)), /misma referencia/);
});

test('movimientos contables no se editan ni se borran', () => {
  assert.throws(() => db.prepare('UPDATE movimientos SET debe_cents = debe_cents + 1').run(), /INMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM movimientos').run(), /INMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM polizas').run(), /INMUTABLE/);
});

test('cancelar un pago reabre el saldo de los cargos', () => {
  const u = db.prepare("SELECT id FROM unidades WHERE clave = 'A-2'").get().id; // unidad sin saldo a favor
  tx(db, () => F.emitirCuotas(db, cid, P, u1));
  const saldo = () => F.cargosAbiertos(db, u).reduce((a, c) => a + c.saldo_cents, 0);
  const antes = saldo();
  const r = tx(db, () => F.registrarPago(db, cid, pago({ unidad_id: u, monto_cents: 300000 }), u1));
  assert.equal(saldo(), antes - 300000);
  tx(db, () => F.cancelarPago(db, cid, r.id, 'prueba', u1));
  assert.equal(saldo(), antes);
});

test('quien captura un egreso no puede aprobarlo', () => {
  const e = tx(db, () => F.crearEgreso(db, cid, { cuenta_id: gasto, fondo: 'operacion', fecha: hoy(), concepto: 'Limpieza', subtotal_cents: 900000, iva_cents: 0, retenciones_cents: 0, idem_key: 'EGR-TEST-1' }, u1));
  assert.equal(e.estado, 'por_aprobar');
  assert.throws(() => tx(db, () => F.aprobarEgreso(db, cid, e.id, true, null, u1)), /Segregación/);
  assert.equal(tx(db, () => F.aprobarEgreso(db, cid, e.id, true, null, u2)).estado, 'aprobado');
});

test('no se registra en un periodo cerrado', () => {
  tx(db, () => F.cerrarPeriodo(db, cid, ANT, u1));
  assert.throws(() => tx(db, () => F.crearPoliza(db, cid, { fecha: `${ANT}-15`, concepto: 'x', origen: 'manual', lineas: [{ cuenta: gasto, debe: 100 }, { cuenta: F.cuenta(db, cid, 'CAJA'), haber: 100 }] }, u1)), /PERIODO_CERRADO/);
  assert.throws(() => db.prepare("UPDATE periodos SET estado = 'abierto' WHERE periodo = ?").run(ANT), /PERIODO_CERRADO/);
});

test('reimportar el mismo estado bancario no duplica movimientos', () => {
  const filas = [{ fecha: hoy(), descripcion: 'SPEI', referencia: 'X1', cargo_cents: 0, abono_cents: 1000 }, { fecha: hoy(), descripcion: 'SPEI', referencia: 'X1', cargo_cents: 0, abono_cents: 1000 }];
  const a = tx(db, () => F.importarMovimientosBanco(db, cid, banco, filas, u1));
  const b = tx(db, () => F.importarMovimientosBanco(db, cid, banco, filas, u1));
  assert.equal(a.nuevos, 2); assert.equal(b.nuevos, 0); assert.equal(b.repetidos, 2);
});

test('libro y submayores cuadran', () => {
  const r = R.verificarIntegridad(db, cid);
  assert.ok(r.ok, JSON.stringify(r));
});

test('alterar la bitácora rompe la cadena', () => {
  S.audit(db, { accion: 'uno' }); S.audit(db, { accion: 'dos' });
  assert.ok(S.verifyAuditChain(db).ok);
  db.exec('DROP TRIGGER t_aud_no_upd');
  db.prepare("UPDATE auditoria SET accion = 'alterado' WHERE accion = 'uno'").run();
  assert.equal(S.verifyAuditChain(db).ok, false);
});

test('respaldo cifrado se crea, verifica y descifra', () => {
  const r = B.crearRespaldo(db, 'prueba');
  assert.ok(r.verificado);
  assert.ok(B.verificarRespaldo(r.archivo).ok);
});

test('TOTP: código válido una sola vez', () => {
  const secret = S.newTotpSecret();
  // generamos el código esperado con la misma función interna vía verificación por fuerza bruta acotada
  let code = null;
  for (let i = 0; i < 1e6 && !code; i++) { const c = String(i).padStart(6, '0'); if (S.verifyTotp(secret, c, 0)) code = c; }
  const step = S.verifyTotp(secret, code, 0);
  assert.ok(step);
  assert.equal(S.verifyTotp(secret, code, step), null);
});
