// Pruebas de la importación masiva (Excel/CSV). Ejecutar: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INDIVISO_DATA = mkdtempSync(join(tmpdir(), 'indiviso-imp-'));
const { openDb, tx } = await import('../server/db.mjs');
const F = await import('../server/finanzas.mjs');
const R = await import('../server/reportes.mjs');
const I = await import('../server/importar.mjs');
const { hoy, periodoDe, addMonths, addDays } = await import('../server/util.mjs');
const { referenciaPago } = await import('../server/api.mjs');

const db = openDb();
const PERMS = { ver: ['admin', 'contador', 'comite'], capturar: ['admin', 'contador'], config: ['admin'] };
const u1 = { id: Number(db.prepare("INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES ('i@t.test','Imp','x',0)").run().lastInsertRowid) };
const cid = tx(db, () => F.crearCondominio(db, { nombre: 'Importaciones', umbral_aprobacion_cents: 2000000 }, u1));
const banco = tx(db, () => F.crearCuentaBanco(db, cid, { nombre: 'Operación', banco: 'BBVA', numero: '0112345678' }));
const codBanco = db.prepare('SELECT k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id WHERE b.id = ?').get(banco).codigo;
const ctx = (rol = 'admin') => ({ db, cid, user: u1, rol, ip: '127.0.0.1' });
const imp = (tipo, filas, aplicar = true, opciones = {}, rol = 'admin') =>
  I.importar(ctx(rol), tipo, { filas, aplicar, opciones, archivo: 'prueba.xlsx' }, { perms: PERMS, rolPuede: p => PERMS[p].includes(rol), referenciaPago });
const ayer = addDays(hoy(), -1);
const dmy = f => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

test('lectura de importes y fechas en los formatos de Excel', () => {
  assert.equal(I.importe('$1,230.50'), 123050);
  assert.equal(I.importe(1230.5), 123050);
  assert.equal(I.importe('1.230,50'), 123050);
  assert.equal(I.importe('(1,000.00)', { negativo: true }), -100000);
  assert.throws(() => I.importe('-5'), /negativo/);
  assert.equal(I.fecha('15/02/2026'), '2026-02-15');
  assert.equal(I.fecha('2026-02-15'), '2026-02-15');
  assert.equal(I.fecha(46068), '2026-02-15');
  assert.throws(() => I.fecha('31/02/2026'), /fecha/);
  assert.equal(I.metodo('03', ['transferencia', 'efectivo']), 'transferencia');
  assert.equal(I.metodo('Efectivo', ['transferencia', 'efectivo']), 'efectivo');
});

test('directorio: crea unidades con torre, personas y luego actualiza sin duplicar', () => {
  const filas = [
    ['Directorio del condominio'], [],
    ['Torre', 'Vivienda', 'Indiviso %', 'Cuota mensual', 'Propietario', 'Correo', 'Teléfono', 'Ocupación'],
    ['Torre 1', '101', '25', '3,000.00', 'Ana Pérez', 'ana@x.test', '9981112233', 'Ocupada'],
    ['Torre 1', '102', '25', '3,000.00', 'Luis Gómez', '', '', 'Desocupada'],
    ['Torre 2', '101', '50', '6,000.00', 'Ana Pérez', 'ana@x.test', '', 'En renta'],
    ['Torre 2', '', '', '', '', '', '', ''],
  ];
  const prev = imp('directorio', filas, false);
  assert.equal(prev.aplicado, false);
  assert.equal(prev.encabezado, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM unidades WHERE condominio_id = ?').get(cid).n, 0, 'validar no guarda nada');
  const r = imp('directorio', filas);
  assert.equal(r.resumen.creados, 3, JSON.stringify(r.filas));
  const us = db.prepare('SELECT clave, indiviso_ppm, cuota_cents, estado FROM unidades WHERE condominio_id = ? ORDER BY clave').all(cid);
  assert.deepEqual(us.map(u => u.clave), ['1-101', '1-102', '2-101']);
  assert.equal(us[2].estado, 'renta');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM personas WHERE condominio_id = ?').get(cid).n, 2, 'misma persona (por correo) en dos unidades');
  const r2 = imp('directorio', [['Torre', 'Vivienda', 'Cuota'], ['Torre 1', '101', '3500']]);
  assert.equal(r2.resumen.actualizados, 1);
  assert.equal(db.prepare("SELECT cuota_cents FROM unidades WHERE condominio_id = ? AND clave = '1-101'").get(cid).cuota_cents, 350000);
  assert.equal(db.prepare("SELECT indiviso_ppm FROM unidades WHERE condominio_id = ? AND clave = '1-101'").get(cid).indiviso_ppm, 250000, 'lo que no viene no se borra');
});

test('saldos iniciales: adeudo y saldo a favor, sin duplicar al reimportar', () => {
  const filas = [['Vivienda', 'Saldo final'], ['1-101', '4,582.65'], ['Torre 1 102', '$-1,500.00 (A favor)'], ['2-101', '0']];
  const r = imp('saldos', filas, true, { fecha_corte: ayer });
  assert.equal(r.resumen.creados, 2, JSON.stringify(r.filas));
  assert.equal(r.resumen.omitidas, 1);
  const c = R.carteraUnidades(db, cid);
  assert.equal(c.find(u => u.clave === '1-101').adeudo, 458265);
  assert.equal(c.find(u => u.clave === '1-102').saldo_favor, 150000);
  const again = imp('saldos', filas, true, { fecha_corte: ayer });
  assert.equal(again.resumen.creados, 0);
  // el saldo inicial no es ingreso del ejercicio ni cobranza
  assert.equal(R.estadoResultados(db, cid, periodoDe(ayer), periodoDe(ayer)).totales.ingresos, 0);
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('pagos: formato de otro sistema, claves SAT, reimportación idempotente y errores por fila', () => {
  const filas = [
    ['Vivienda', 'Importe', 'Fecha de pago', 'Forma de pago', 'Cuenta de caja o banco', 'Referencia', 'Comentarios'],
    ['1-101', '4582.65', dmy(ayer), '03', codBanco, 'SPEI-1', 'Pago enero'],
    ['Torre 1 102', 1000, dmy(ayer), 'Efectivo', '', '', ''],
    ['9-999', '100', dmy(ayer), '03', codBanco, 'X', ''],
    ['1-101', 'abc', dmy(ayer), '03', codBanco, 'Y', ''],
  ];
  const r = imp('pagos', filas);
  assert.equal(r.resumen.validas, 2, JSON.stringify(r.filas));
  assert.equal(r.resumen.errores, 2);
  assert.match(r.filas.find(f => f.n === 4).error, /No existe la unidad/);
  assert.equal(R.carteraUnidades(db, cid).find(u => u.clave === '1-101').adeudo, 0);
  const again = imp('pagos', filas);
  assert.equal(again.resumen.validas, 0);
  assert.equal(again.resumen.omitidas, 2, 'reimportar el mismo archivo no duplica');
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('pagos: sin cuenta en la fila usa la cuenta por defecto; sin ella, error claro', () => {
  const sin = imp('pagos', [['Unidad', 'Fecha', 'Importe'], ['2-101', dmy(ayer), '6000']], false);
  assert.match(sin.filas[0].error, /cuenta bancaria/);
  const con = imp('pagos', [['Unidad', 'Fecha', 'Importe'], ['2-101', dmy(ayer), '6000']], false, { cuenta_banco_id: banco });
  assert.equal(con.resumen.validas, 1);
});

test('egresos: plantilla de otro sistema, proveedor nuevo, partida por nombre y pago', () => {
  const filas = [
    ['Concepto', 'Proveedor', 'Importe', 'Fecha', 'Forma de pago', 'Cuenta Bancaria', 'Referencia', 'Clasificacion presupuestal', 'Fondo', 'Comentarios'],
    ['Pago Febrero', 'Gas Natural', '1230', dmy(ayer), '03', codBanco, '123-3', 'Gas', 'Ordinario', 'Egreso de ejemplo'],
    ['Vigilancia', 'Vigilantes AC', '25000', dmy(ayer), '03', codBanco, '23-A', '5201', '', ''],
    ['Equipo', 'Vigilantes AC', '500', dmy(ayer), '', '', '', 'Partida inexistente', '', ''],
  ];
  const prev = imp('egresos', filas, false, {}, 'contador');
  assert.equal(prev.resumen.validas, 2, JSON.stringify(prev.filas));
  assert.match(prev.filas[2].error, /No existe la partida/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proveedores WHERE condominio_id = ?').get(cid).n, 0, 'la vista previa no crea proveedores');
  const r = imp('egresos', filas, true, {}, 'contador');
  const es = db.prepare('SELECT folio, estado, total_cents FROM egresos WHERE condominio_id = ? ORDER BY folio').all(cid);
  assert.deepEqual(es.map(e => e.estado), ['pagado', 'por_aprobar'], 'arriba del umbral espera aprobación');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proveedores WHERE condominio_id = ?').get(cid).n, 2);
  assert.match(r.filas[1].detalle, /requiere aprobación/);
  assert.equal(imp('egresos', filas, true, {}, 'contador').resumen.omitidas, 2);
  // el contador no puede crear partidas; el administrador sí
  assert.equal(imp('egresos', [filas[0], filas[3]], false, { crear_partidas: true }, 'contador').resumen.errores, 1);
  const a = imp('egresos', [filas[0], filas[3]], true, { crear_partidas: true }, 'admin');
  assert.equal(a.resumen.partidas_nuevas.length, 1);
  assert.equal(R.verificarIntegridad(db, cid).ok, true);
});

test('presupuesto: importes anuales se reparten en 12 meses sin perder centavos', () => {
  const pid = tx(db, () => F.nuevaVersionPresupuesto(db, cid, +hoy().slice(0, 4), u1));
  const r = imp('presupuesto', [['Partida', 'Anual', 'Ene', 'Feb'], ['5201', '100,000.01', '', ''], ['Limpieza', '', '1000', '2000'], ['5201', '1', '', '']], true, { presupuesto_id: pid });
  assert.equal(r.resumen.validas, 2, JSON.stringify(r.filas));
  assert.match(r.filas[2].error, /dos veces/);
  const tot = db.prepare('SELECT SUM(monto_cents) s FROM presupuesto_lineas WHERE presupuesto_id = ?').get(pid).s;
  assert.equal(tot, 10000001 + 300000);
});

test('sin permiso o sin encabezados, la importación se rechaza', () => {
  assert.throws(() => imp('directorio', [['Unidad'], ['X']], false, {}, 'contador'), /permiso/);
  assert.throws(() => imp('pagos', [['a', 'b'], ['1', '2']], false), /encabezados/);
});
