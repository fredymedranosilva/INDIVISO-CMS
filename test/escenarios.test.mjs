// Casos de uso reales con varios condominios operando a la vez, todo por HTTP contra el servidor real:
// alta del condominio, usuarios, directorio, presupuesto, saldos iniciales, tres meses de cuotas, pagos, egresos
// con aprobación, bancos y conciliación, correcciones y cierres. Al final se verifica que todo cuadre con el libro.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servidor, Cliente, idem, PDF_B64 } from './apoyo.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'indiviso-esc-'));
process.env.INDIVISO_DATA = DATA;
const { openDb } = await import('../server/db.mjs');
const { hashPassword, verifyAuditChain } = await import('../server/security.mjs');
const { hoy, addMonths, periodoDe, finDeMes, addDays } = await import('../server/util.mjs');

const db = openDb();
const PASS = 'Clave-Segura-2026!';
db.prepare('INSERT INTO usuarios (email, nombre, pass_hash, superadmin, created_at, pass_cambiado_at) VALUES (?,?,?,1,?,?)').run('direccion@t.test', 'Dirección', hashPassword(PASS), Date.now(), Date.now());
const srv = await servidor(DATA);
after(async () => { await srv.parar(); db.close(); });

const HOY = hoy(), M = periodoDe(HOY), M1 = addMonths(M, -1), M2 = addMonths(M, -2), M3 = addMonths(M, -3);
const dia = (p, d) => { const f = `${p}-${String(Math.min(d, 28)).padStart(2, '0')}`; return f > HOY ? HOY : f; };
const dmy = f => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
const sup = new Cliente(srv.url);
assert.equal((await sup.login('direccion@t.test', PASS)).status, 200);

// Tres condominios con reglas distintas
const CONDOS = [
  { clave: 'torre', nombre: 'Torre Mirador', n: 12, cuota: i => 280000 + (i % 4) * 35000, config: { dia_vencimiento: 10, dias_gracia: 0, tasa_recargo_bp: 500, recargo_modo: 'cuota', pct_reserva_bp: 1000, umbral_aprobacion_cents: 500000, pronto_pago_bp: 500, pronto_pago_dia: 10 } },
  { clave: 'privada', nombre: 'Privada Los Olivos', n: 30, cuota: () => 150000, config: { dia_vencimiento: 5, dias_gracia: 5, tasa_recargo_bp: 0, recargo_modo: 'fijo', recargo_fijo_cents: 10000, pct_reserva_bp: 0, umbral_aprobacion_cents: 2000000 } },
  { clave: 'plaza', nombre: 'Plaza Comercial Centro', n: 8, cuota: i => 600000 + i * 110000, config: { dia_vencimiento: 15, dias_gracia: 3, tasa_recargo_bp: 300, recargo_modo: 'saldo', pct_reserva_bp: 500, umbral_aprobacion_cents: 1000000 } },
];

// Alta de un usuario invitado: entra con la contraseña temporal y la cambia
async function alta(admin, cid, nombre, email, rol, persona_id = null) {
  const inv = await admin.ok('POST', `/api/c/${cid}/usuarios`, { nombre, email, rol, persona_id });
  const c = new Cliente(srv.url);
  assert.equal((await c.login(email, inv.password_temporal)).json.cambiar_password, true);
  assert.equal((await c.post('/api/auth/password', { actual: inv.password_temporal, nueva: PASS })).status, 200);
  await c.sesion();
  return c;
}

async function operar(C) {
  // ---- 1. Alta del condominio y de su equipo
  const cid = C.id = (await sup.ok('POST', '/api/condominios', { nombre: C.nombre, ciudad: 'Monterrey' })).id;
  const a = p => `/api/c/${cid}${p}`;
  const admin = C.admin = await alta(sup, cid, `Admin ${C.clave}`, `admin@${C.clave}.test`, 'admin');
  const cont = C.cont = await alta(admin, cid, `Contadora ${C.clave}`, `conta@${C.clave}.test`, 'contador');
  const com = C.com = await alta(admin, cid, `Comité ${C.clave}`, `comite@${C.clave}.test`, 'comite');
  assert.deepEqual(admin.me.condominios.map(x => x.id), [cid], 'cada administrador ve solo su condominio');
  await admin.ok('PUT', a('/config'), { nombre: C.nombre, ciudad: 'Monterrey', ...C.config });
  const bOp = C.bOp = await admin.ok('POST', a('/bancos'), { nombre: 'Operación', banco: 'BBVA', numero: `01234567${cid}0`, fondo: 'operacion' });
  const bRes = C.bRes = await admin.ok('POST', a('/bancos'), { nombre: 'Reserva', banco: 'BBVA', numero: `01234567${cid}9`, fondo: 'reserva' });
  const cat = await admin.ok('GET', a('/importar/catalogos'));
  const codOp = cat.bancos.find(b => b.id === bOp).codigo;

  // ---- 2. Directorio desde Excel (como lo haría un usuario) y un residente con acceso
  const filas = [['Clave', 'Torre', 'Tipo', 'Indiviso %', 'Cuota mensual', 'Ocupación', 'Propietario', 'Correo', 'Teléfono']];
  const cuotas = Array.from({ length: C.n }, (_, i) => C.cuota(i)), suma = cuotas.reduce((x, y) => x + y, 0);
  let acum = 0;
  cuotas.forEach((q, i) => {
    const ind = i === C.n - 1 ? 1000000 - acum : Math.round(q / suma * 1000000); acum += ind; // en ppm; la última ajusta a 100%
    filas.push([`${C.clave === 'torre' ? 'D' : C.clave === 'privada' ? 'C' : 'L'}-${String(i + 1).padStart(2, '0')}`, C.clave === 'torre' ? 'Torre Única' : '', C.clave === 'plaza' ? 'local' : C.clave === 'privada' ? 'casa' : 'departamento',
      (ind / 10000).toFixed(4), (q / 100).toFixed(2), 'Ocupada', `Propietario ${i + 1} de ${C.clave}`, `p${i + 1}@${C.clave}.test`, `81${String(10000000 + cid * 1000 + i)}`]);
  });
  const imp = await admin.ok('POST', a('/importar/directorio'), { filas, aplicar: true });
  assert.equal(imp.resumen.creados, C.n, JSON.stringify(imp.filas.filter(x => !x.ok)));
  const us = C.unidades = (await admin.ok('GET', a('/unidades'))).sort((x, y) => x.clave.localeCompare(y.clave));
  assert.equal(us.reduce((x, u) => x + u.indiviso_ppm, 0), 1000000, 'los indivisos suman 100%');
  const per0 = (await admin.ok('GET', a(`/unidades/${us[0].id}`))).personas[0].id;
  const res = C.res = await alta(admin, cid, `Residente ${C.clave}`, `res@${C.clave}.test`, 'residente', per0);

  // ---- 3. Presupuesto del ejercicio: la contadora lo captura y la administración lo aprueba
  const pid = await cont.ok('POST', a('/presupuestos'), { ejercicio: +HOY.slice(0, 4) });
  const pr = await cont.ok('GET', a(`/presupuestos/${pid}`));
  const partidas = C.partidas = Object.fromEntries(pr.cuentas.map(k => [k.codigo, k.id]));
  await cont.ok('PUT', a(`/presupuestos/${pid}/lineas`), { lineas: ['5101', '5201', '5202', '5302', '5401', '5502'].flatMap((cod, j) => Array.from({ length: 12 }, (_, m) => ({ cuenta_id: partidas[cod], mes: m + 1, monto_cents: Math.round(suma * [0.12, 0.3, 0.15, 0.1, 0.12, 0.01][j]) }))) });
  assert.equal((await cont.post(a(`/presupuestos/${pid}/aprobar`), { acta: 'x' })).status, 403, 'la contadora no aprueba el presupuesto');
  await admin.ok('POST', a(`/presupuestos/${pid}/aprobar`), { acta: 'Asamblea ordinaria' });

  // ---- 4. Saldos iniciales (lo que traía cada unidad del sistema anterior)
  const corte = addDays(`${M3}-01`, -1);
  const si = await admin.ok('POST', a('/importar/saldos'), { filas: [['Unidad', 'Saldo'], [us[2].clave, '3,500.00'], [us[3].clave, '-1,200.00 (A favor)'], [us[4].clave, 0]], aplicar: true, opciones: { fecha_corte: corte } });
  assert.equal(si.resumen.creados, 2);

  // ---- 5. Tres meses de operación más el mes en curso
  const pagar = (u, monto, fecha, extra = {}) => cont.ok('POST', a('/pagos'), { unidad_id: u.id, fecha, monto_cents: monto, metodo: 'transferencia', cuenta_banco_id: bOp, referencia: `SPEI${cid}${u.id}${fecha.replaceAll('-', '')}${monto}`, idem_key: idem(), confirmar_duplicado: true, ...extra });
  const egreso = async (quien, cod, concepto, monto, fecha, extra = {}) => quien.ok('POST', a('/egresos'), { cuenta_id: partidas[cod], fondo: 'operacion', fecha, concepto, subtotal_cents: monto, iva_cents: 0, retenciones_cents: 0, idem_key: idem(), ...extra });
  const prov = await cont.ok('POST', a('/proveedores'), { nombre: `Vigilancia ${C.clave}`, rfc: `VIG01010${cid}AB1`.slice(0, 12) });
  C.pagosM3 = [];
  for (const [k, P] of [M3, M2, M1, M].entries()) {
    const em = await cont.ok('POST', a('/cobranza/emitir'), { periodo: P });
    assert.equal(em.emitidos, C.n);
    assert.equal((await cont.ok('POST', a('/cobranza/emitir'), { periodo: P })).emitidos, 0, 'emitir dos veces no duplica');
    if (k > 0 && (C.config.tasa_recargo_bp || C.config.recargo_fijo_cents)) await cont.ok('POST', a('/cobranza/recargos'), { periodo: P });
    for (const [i, u] of us.entries()) {
      if (i % 10 === 9) continue;                                   // moroso: nunca paga
      if (P === M && i % 3) continue;                               // en el mes en curso solo algunos han pagado
      const pp = C.config.pronto_pago_bp && i % 7 === 0;            // paga antes del día límite con descuento
      let monto = i % 10 === 8 ? Math.round(u.cuota_cents / 2) : pp ? u.cuota_cents - Math.round(u.cuota_cents * C.config.pronto_pago_bp / 10000) : u.cuota_cents;
      if (i === 1 && P === M2) monto += 50000;                      // paga de más: queda saldo a favor
      const r = await pagar(u, monto, dia(P, pp ? 3 : 6 + (i % 14)), i % 5 === 4 ? { metodo: 'efectivo', cuenta_banco_id: null, referencia: null } : {});
      if (P === M3) C.pagosM3.push({ id: r.id, monto });
      if (pp && P !== M) assert.ok(r.descuento > 0, 'descuento por pronto pago aplicado');
    }
    // egresos: tres chicos (se aprueban solos y se pagan) y uno grande (lo aprueba el comité)
    for (const [cod, concepto, pct] of [['5101', 'Luz áreas comunes', 0.1], ['5202', 'Limpieza', 0.12], ['5502', 'Comisiones bancarias', 0.005]]) {
      const monto = Math.min(Math.round(suma * pct), C.config.umbral_aprobacion_cents - 100);
      const e = await egreso(cont, cod, `${concepto} ${P}`, monto, dia(P, 12), cod === '5202' ? { proveedor_id: prov } : {});
      assert.equal(e.estado, 'aprobado');
      await cont.ok('POST', a(`/egresos/${e.id}/pagar`), { fecha_pago: dia(P, 14), metodo: 'transferencia', cuenta_banco_id: bOp, referencia: `PAGO-${e.folio}` });
    }
    const grande = await egreso(cont, '5201', `Vigilancia ${P}`, C.config.umbral_aprobacion_cents + 150000, dia(P, 15), { proveedor_id: prov, factura_folio: `F-${P}` });
    assert.equal(grande.estado, 'por_aprobar');
    assert.equal((await cont.post(a(`/egresos/${grande.id}/aprobar`), { aprobar: true })).status, 403);
    await com.ok('POST', a(`/egresos/${grande.id}/aprobar`), { aprobar: true });
    if (P !== M) await admin.ok('POST', a(`/egresos/${grande.id}/pagar`), { fecha_pago: dia(P, 20), metodo: 'transferencia', cuenta_banco_id: bOp, referencia: `PAGO-${grande.folio}` });
  }
  // traspaso al fondo de reserva y un gasto del fondo
  await cont.ok('POST', a('/polizas'), { tipo: 'D', fecha: dia(M2, 25), concepto: 'Traspaso a cuenta de reserva', lineas: [{ cuenta: cat.bancos.length ? (await admin.ok('GET', a('/bancos'))).find(b => b.id === bRes).cuenta_id : 0, debe: 2000000, haber: 0 }, { cuenta: (await admin.ok('GET', a('/bancos'))).find(b => b.id === bOp).cuenta_id, debe: 0, haber: 2000000 }] });
  const eRes = await egreso(cont, '5302', 'Impermeabilización (fondo de reserva)', 800000, dia(M1, 8), { fondo: 'reserva' });
  assert.equal(eRes.estado, 'por_aprobar', 'todo uso del fondo requiere aprobación');
  await com.ok('POST', a(`/egresos/${eRes.id}/aprobar`), { aprobar: true });
  await admin.ok('POST', a(`/egresos/${eRes.id}/pagar`), { fecha_pago: dia(M1, 10), metodo: 'transferencia', cuenta_banco_id: bRes, referencia: 'RES-1' });
  // extraordinaria, multa y cargo recurrente
  if (C.clave === 'plaza') {
    const fondo = await admin.ok('POST', a('/fondos'), { nombre: 'Remodelación de fachada', meta_cents: 50000000 });
    await cont.ok('POST', a('/cobranza/extraordinaria'), { concepto: 'Remodelación de fachada 1/3', total_cents: 9000000, metodo: 'indiviso', destino: 'fondo', fondo_id: fondo, fecha: dia(M1, 1), vencimiento: dia(M1, 28) });
    await pagar(us[0], 9000000 * us[0].indiviso_ppm / 1000000 | 0, dia(M1, 20));
  }
  const multa = await cont.ok('POST', a('/cobranza/cargo'), { unidad_id: us[5].id, tipo: 'multa', concepto: 'Multa por ruido', monto_cents: 50000, fecha: dia(M1, 18) });
  assert.equal(multa.emitidos, 1);
  await cont.ok('POST', a('/cargos-recurrentes'), { unidad_id: us[6].id, tipo: 'otro', concepto: 'Cajón adicional', monto_cents: 40000, desde: addMonths(M, 1) });

  // ---- 6. Estado de cuenta bancario del mes anterior: conciliación automática y un depósito sin identificar
  const pagosM1 = (await admin.ok('GET', a(`/pagos?desde=${M1}-01&hasta=${finDeMes(M1)}`))).filter(p => p.cuenta_banco_id === bOp && p.estado === 'aplicado');
  const egM1 = (await admin.ok('GET', a(`/egresos?estado=pagado&desde=${M1}-01&hasta=${finDeMes(M1)}`))).filter(e => e.cuenta_banco_id === bOp);
  const movs = [...pagosM1.map(p => ({ fecha: p.fecha, descripcion: `SPEI RECIBIDO ${p.referencia}`, referencia: p.referencia, cargo_cents: 0, abono_cents: p.monto_cents })),
    ...egM1.map(e => ({ fecha: e.fecha_pago, descripcion: `SPEI ENVIADO ${e.referencia_pago}`, referencia: e.referencia_pago, cargo_cents: e.total_cents, abono_cents: 0 })),
    { fecha: dia(M1, 22), descripcion: `DEPOSITO EN VENTANILLA ${us[7].referencia}`, referencia: 'VENT-77', cargo_cents: 0, abono_cents: 123400 }];
  const bi = await cont.ok('POST', a(`/bancos/${bOp}/importar`), { filas: movs });
  assert.equal(bi.nuevos, movs.length);
  assert.equal((await cont.ok('POST', a(`/bancos/${bOp}/importar`), { filas: movs })).nuevos, 0, 'reimportar el estado de cuenta no duplica');
  const pend = await cont.ok('GET', a(`/bancos/${bOp}/movimientos?estado=pendientes`));
  const dep = pend.find(x => x.abono_cents === 123400);
  assert.equal(dep?.sugerida?.id, us[7].id, 'la referencia de la unidad en el depósito sugiere a quién abonarlo');
  await cont.ok('POST', a(`/banco-movs/${dep.id}/crear-pago`), { unidad_id: us[7].id });
  for (const x of pend.filter(y => y.id !== dep.id)) { const cs = await cont.ok('GET', a(`/banco-movs/${x.id}/candidatos`)); if (cs[0]) await cont.ok('POST', a(`/banco-movs/${x.id}/conciliar`), { tipo: cs[0].tipo, id: cs[0].id }); }
  assert.equal((await cont.ok('GET', a(`/bancos/${bOp}/movimientos?estado=pendientes`))).length, 0, 'todo el mes anterior queda conciliado');

  // ---- 7. El residente reporta un pago con comprobante; la administración lo valida
  const arch = await res.ok('POST', a('/archivos'), { nombre: 'transferencia.pdf', base64: PDF_B64 });
  const rep = await res.ok('POST', a('/mi/pagos'), { unidad_id: us[0].id, fecha: HOY, monto_cents: 100000, metodo: 'transferencia', referencia: `APP${cid}`, comprobante_id: arch.id, idem_key: idem() });
  assert.equal(rep.estado, 'por_validar');
  assert.equal((await res.post(a(`/pagos/${rep.id}/validar`), { aceptar: true })).status, 403);
  const val = await cont.ok('POST', a(`/pagos/${rep.id}/validar`), { aceptar: true, cuenta_banco_id: bOp });
  assert.ok(val.folio > 0);
  const mi = await res.ok('GET', a('/mi'));
  assert.equal(mi.unidades.length, 1); assert.equal(mi.unidades[0].unidad.id, us[0].id);

  // ---- 8. Comunidad: aviso y votación
  await admin.ok('POST', a('/comunidad'), { tipo: 'aviso', titulo: 'Corte de agua el sábado', cuerpo: 'De 9 a 13 h por mantenimiento de cisterna.' });
  const enc = await com.ok('POST', a('/encuestas'), { pregunta: '¿Se aprueba pintar la fachada?', cierra: addDays(HOY, 7), ponderada: true, opciones: ['Sí', 'No'] });
  const op = (await res.ok('GET', a('/encuestas'))).find(e => e.id === enc).opciones[0].id;
  await res.ok('POST', a(`/encuestas/${enc}/votar`), { opcion_id: op, unidad_id: us[0].id });
  assert.equal((await res.post(a(`/encuestas/${enc}/votar`), { opcion_id: op, unidad_id: us[0].id })).status, 409, 'un voto por unidad');
  return C;
}

test('tres condominios operan a la vez sin mezclarse y con todo cuadrado', async () => {
  await Promise.all(CONDOS.map(operar));
  for (const C of CONDOS) {
    const a = p => `/api/c/${C.id}${p}`;
    const integ = await C.admin.ok('GET', a('/integridad'));
    assert.equal(integ.ok, true, `${C.nombre}: ${JSON.stringify(integ)}`);
  }
  // Folios consecutivos e independientes por condominio
  for (const C of CONDOS) {
    const fol = db.prepare('SELECT folio FROM pagos WHERE condominio_id = ? AND folio IS NOT NULL ORDER BY folio').all(C.id).map(x => x.folio);
    assert.deepEqual(fol, fol.map((_, i) => i + 1), `${C.nombre}: recibos consecutivos desde 1`);
    const eg = db.prepare('SELECT folio FROM egresos WHERE condominio_id = ? ORDER BY folio').all(C.id).map(x => x.folio);
    assert.deepEqual(eg, eg.map((_, i) => i + 1));
  }
  // Nada cruzado: cada póliza toca solo cuentas y unidades de su condominio
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id WHERE k.condominio_id <> p.condominio_id').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN unidades u ON u.id = m.unidad_id WHERE u.condominio_id <> p.condominio_id').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id JOIN pagos p ON p.id = a.pago_id WHERE c.condominio_id <> p.condominio_id OR c.unidad_id <> p.unidad_id').get().n, 0);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------- Cuadres: cada reporte contra el libro contable ----------
const cuentasEfectivo = cid => db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND (clave = 'CAJA' OR id IN (SELECT cuenta_id FROM cuentas_banco WHERE condominio_id = ?))").all(cid, cid).map(x => x.id);
const libro = (cid, cuentas, origenes, desde, hasta) => db.prepare(`SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id
  WHERE p.condominio_id = ? AND p.fecha BETWEEN ? AND ? AND m.cuenta_id IN (${cuentas.join(',') || 0}) ${origenes ? `AND p.origen IN (${origenes.map(o => `'${o}'`).join(',')})` : ''}`).get(cid, desde, hasta).s;
const mesDe = p => ({ anio: +p.slice(0, 4), mes: +p.slice(5, 7) });

async function cuadres(C, etiqueta) {
  const a = p => `/api/c/${C.id}${p}`, ef = cuentasEfectivo(C.id);
  const gasto = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND (tipo = 'egreso' OR tipo = 'patrimonio')").all(C.id).map(x => x.id);
  for (const P of [M3, M2, M1, M]) {
    const { anio, mes } = mesDe(P), d = `${P}-01`, h = finDeMes(P);
    const ing = await C.admin.ok('GET', a(`/reportes/ingresos?anio=${anio}&mes=${mes}`));
    assert.equal(ing.total, libro(C.id, ef, ['pago', 'cancelacion_pago'], d, h), `${etiqueta} ${C.nombre} ${P}: ingresos = entradas a bancos y caja por cobranza`);
    assert.equal(ing.grupos.reduce((x, g) => x + g.total, 0), ing.total);
    assert.equal(ing.por_metodo.reduce((x, g) => x + g.monto, 0), ing.cobrado);
    assert.equal(ing.por_cuenta.reduce((x, g) => x + g.monto, 0), ing.cobrado);
    assert.equal(ing.por_unidad.reduce((x, g) => x + g.monto, 0), ing.cobrado);
    assert.equal(ing.recibos.reduce((x, r) => x + r.monto, 0), ing.cobrado);
    for (const g of ing.grupos) for (const c of g.clasificaciones) assert.equal(c.conceptos.reduce((x, y) => x + y.total, 0), c.total);
    const eg = await C.admin.ok('GET', a(`/reportes/egresos?anio=${anio}&mes=${mes}`));
    assert.equal(eg.total, libro(C.id, gasto, ['egreso', 'cancelacion_egreso'], d, h), `${etiqueta} ${C.nombre} ${P}: egresos = cargos a partidas y fondos`);
    assert.equal(eg.por_proveedor.reduce((x, g) => x + g.monto, 0), eg.total);
    assert.equal(eg.pagado + eg.por_pagar + eg.cancelado_neto, eg.total);
    const bn = await C.admin.ok('GET', a(`/reportes/bancos?anio=${anio}&mes=${mes}`));
    for (const c of bn.cuentas) {
      assert.equal(c.anterior + c.ingresos - c.egresos, c.final);
      assert.equal(c.final, libro(C.id, [c.cuenta_id], null, '0000-01-01', h), `${C.nombre} ${P}: saldo de ${c.nombre}`);
      assert.equal(c.movimientos.at(-1)?.saldo ?? c.anterior, c.final, 'el detalle de movimientos llega al saldo final');
    }
    // cartera al cierre del mes = libro (cuentas por cobrar − saldos a favor) a esa fecha
    const corte = h > HOY ? HOY : h;
    const mo = await C.admin.ok('GET', a(`/morosidad?corte=${corte}&detalle=1`));
    const cxc = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND clave IN ('CXC','ANTICIPOS')").all(C.id).map(x => x.id);
    assert.equal(mo.unidades.reduce((x, u) => x + u.adeudo - u.saldo_favor, 0), libro(C.id, cxc, null, '0000-01-01', corte), `${etiqueta} ${C.nombre}: cartera al ${corte} = libro`);
    assert.equal(mo.cargos.reduce((x, c) => x + c.saldo_cents, 0), mo.unidades.reduce((x, u) => x + u.adeudo, 0));
    assert.equal(mo.resumen.vencido + mo.resumen.por_vencer, mo.unidades.reduce((x, u) => x + u.adeudo, 0));
  }
  // año completo, tablero, estados de cuenta, liquidación, presupuesto
  const anio = +HOY.slice(0, 4);
  const t = await C.admin.ok('GET', a('/tablero'));
  const mo = await C.admin.ok('GET', a('/morosidad'));
  assert.equal(t.kpis.cartera_vencida, mo.resumen.vencido);
  assert.equal(t.kpis.bancos.total, libro(C.id, ef, null, '0000-01-01', '9999-12-31'));
  assert.equal(t.kpis.recaudado, (await C.admin.ok('GET', a(`/reportes/ingresos?anio=${anio}&mes=${+M.slice(5)}`))).cobrado);
  for (const u of mo.unidades) {
    const ec = await C.admin.ok('GET', a(`/estado-cuenta/${u.id}?desde=2000-01-01&hasta=${HOY}`));
    assert.equal(ec.saldo_final, u.adeudo - u.saldo_favor, `${C.nombre} ${u.clave}: estado de cuenta = cartera`);
    assert.equal(ec.saldo_inicial + ec.cargos - ec.abonos, ec.saldo_final);
    assert.equal(ec.movimientos.at(-1)?.saldo ?? 0, ec.saldo_final);
    assert.equal(ec.pendientes.filter(p => p.vencimiento <= '9999').reduce((x, p) => x + p.saldo_cents, 0) >= u.adeudo, true);
    assert.equal(ec.saldo_favor, u.saldo_favor);
  }
  const fl = await C.admin.ok('GET', a(`/reportes/flujo?desde=${M3}&hasta=${M}`));
  assert.equal(fl.final, t.kpis.bancos.total);
  const bal = await C.admin.ok('GET', a(`/reportes/balance?hasta=${M}`));
  assert.equal(bal.cuadra, true);
  const er = await C.admin.ok('GET', a(`/reportes/resultados?desde=${anio}-01&hasta=${M}`));
  const pv = await C.admin.ok('GET', a(`/reportes/presupuesto?ejercicio=${anio}`));
  if (M3.startsWith(String(anio))) assert.equal(pv.totales.ejercido, er.totales.egresos, 'ejercido del presupuesto = egresos del estado de resultados');
  const liq = await C.admin.ok('GET', a(`/reportes/liquidacion?ejercicio=${anio}`));
  assert.equal(liq.totales.emitido, db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM cargos WHERE condominio_id = ? AND cancelado_at IS NULL AND periodo BETWEEN ? AND ?").get(C.id, `${anio}-01`, `${anio}-12`).s);
  const cxp = await C.admin.ok('GET', a('/reportes/cxp'));
  assert.equal(cxp.totales.total, db.prepare("SELECT COALESCE(SUM(total_cents), 0) s FROM egresos WHERE condominio_id = ? AND estado = 'aprobado'").get(C.id).s);
  const co = await C.admin.ok('GET', a(`/reportes/conciliacion?anio=${anio}&mes=${+M.slice(5)}`));
  const op = co.cuentas.find(x => x.id === C.bOp);
  assert.equal(op.diferencia, 0, `${C.nombre}: conciliación sin diferencia (${JSON.stringify({ banco: op.saldo_banco, libros: op.libros, dT: op.depositos_transito, pT: op.pagos_transito })})`);
  assert.equal((await C.admin.ok('GET', a('/integridad'))).ok, true);
}

test('los reportes cuadran con el libro contable en cada condominio y cada mes', async () => {
  for (const C of CONDOS) await cuadres(C, 'inicial');
  // Consolidado de la administradora = suma de los tableros
  const cons = await sup.ok('GET', '/api/consolidado');
  assert.equal(cons.length, CONDOS.length);
  for (const C of CONDOS) {
    const t = await C.admin.ok('GET', `/api/c/${C.id}/tablero`), fila = cons.find(x => x.id === C.id);
    for (const k of ['emitido', 'cobrado', 'recaudado', 'cartera_vencida', 'fondo_reserva', 'egresos_mes']) assert.equal(fila[k], t.kpis[k], `consolidado ${k}`);
  }
});

test('correcciones y cierres: los meses cerrados no cambian', async () => {
  const fotos = new Map();
  const foto = async C => {
    const a = p => `/api/c/${C.id}${p}`, out = {};
    for (const P of [M3, M2]) {
      const { anio, mes } = mesDe(P);
      const ing = await C.admin.ok('GET', a(`/reportes/ingresos?anio=${anio}&mes=${mes}`)), eg = await C.admin.ok('GET', a(`/reportes/egresos?anio=${anio}&mes=${mes}`));
      const bn = await C.admin.ok('GET', a(`/reportes/bancos?anio=${anio}&mes=${mes}`)), mo = await C.admin.ok('GET', a(`/morosidad?corte=${finDeMes(P)}`));
      const er = await C.admin.ok('GET', a(`/reportes/resultados?desde=${P}&hasta=${P}`)), bal = await C.admin.ok('GET', a(`/reportes/balance?hasta=${P}`));
      out[P] = { ingresos: [ing.total, ing.cobrado, ing.pagos, ing.por_metodo, ing.por_cuenta], egresos: [eg.total, eg.documentos, eg.por_proveedor], bancos: bn.cuentas.map(c => [c.nombre, c.anterior, c.ingresos, c.egresos, c.final]),
        cartera: [mo.resumen.vencido, mo.resumen.por_vencer, mo.resumen.saldo_favor, mo.unidades.map(u => [u.clave, u.adeudo, u.saldo_favor])], resultados: er.totales, balance: [bal.total_activo, bal.total_pasivo, bal.total_patrimonio] };
    }
    return JSON.stringify(out);
  };
  await Promise.all(CONDOS.map(async C => {
    const a = p => `/api/c/${C.id}${p}`;
    // el contador no cierra; la administración sí, en orden
    assert.equal((await C.cont.post(a(`/periodos/${M3}/cerrar`))).status, 403);
    assert.equal((await C.admin.post(a(`/periodos/${M2}/cerrar`))).status, 409, 'no se cierra un mes con el anterior abierto');
    await C.admin.ok('POST', a(`/periodos/${addMonths(M3, -1)}/cerrar`)); // el mes de los saldos iniciales
    await C.admin.ok('POST', a(`/periodos/${M3}/cerrar`));
    await C.admin.ok('POST', a(`/periodos/${M2}/cerrar`));
    assert.equal((await C.admin.post(a(`/periodos/${M}/cerrar`))).status, 409, 'no se cierra el mes en curso');
    fotos.set(C.id, await foto(C));
  }));
  await Promise.all(CONDOS.map(async C => {
    const a = p => `/api/c/${C.id}${p}`, us = C.unidades;
    // un pago con fecha de un mes cerrado se asienta hoy; un gasto en mes cerrado también
    const tarde = await C.cont.ok('POST', a('/pagos'), { unidad_id: us[2].id, fecha: dia(M3, 27), monto_cents: 77700, metodo: 'efectivo', idem_key: idem(), confirmar_duplicado: true });
    assert.ok(tarde.folio);
    const eT = await C.cont.ok('POST', a('/egresos'), { cuenta_id: C.partidas['5302'], fondo: 'operacion', fecha: dia(M2, 9), concepto: 'Factura atrasada', subtotal_cents: 33300, iva_cents: 0, retenciones_cents: 0, idem_key: idem() });
    await C.cont.ok('POST', a(`/egresos/${eT.id}/pagar`), { fecha_pago: HOY, metodo: 'efectivo' });
    assert.equal((await C.cont.post(a('/polizas'), { tipo: 'D', fecha: dia(M3, 10), concepto: 'ajuste en mes cerrado', lineas: [{ cuenta: C.partidas['5590'] ?? C.partidas['5302'], debe: 100, haber: 0 }, { cuenta: C.partidas['5101'], debe: 0, haber: 100 }] })).json.code, 'PERIODO_CERRADO');
    // cancelar un recibo y un egreso de un mes cerrado: la contrapóliza va en el mes en curso
    await C.admin.ok('POST', a(`/pagos/${C.pagosM3[0].id}/cancelar`), { motivo: 'Depósito devuelto por el banco' });
    const eg3 = (await C.admin.ok('GET', a(`/egresos?desde=${M3}-01&hasta=${finDeMes(M3)}`))).find(e => e.estado === 'pagado');
    await C.admin.ok('POST', a(`/egresos/${eg3.id}/cancelar`), { motivo: 'Factura duplicada' });
    // bonificación, cancelación de cargo, convenio con condonación y descuento por lote
    const cargos = await C.admin.ok('GET', a(`/cargos?unidad=${us[9 % us.length].id}`));
    const abierto = cargos.find(c => c.saldo_cents > 1000 && !c.cancelado_at && c.tipo === 'ordinaria');
    await C.admin.ok('POST', a(`/cargos/${abierto.id}/bonificar`), { monto_cents: 1000, motivo: 'Ajuste acordado en asamblea' });
    const multa = (await C.admin.ok('GET', a(`/cargos?unidad=${us[5].id}`))).find(c => c.tipo === 'multa');
    if (multa.saldo_cents === multa.monto_cents) await C.admin.ok('POST', a(`/cargos/${multa.id}/cancelar`), { motivo: 'Multa improcedente' });
    const conv = await C.admin.ok('POST', a('/convenios'), { unidad_id: us[9 % us.length].id, parcialidades: 6, fecha: HOY, condonar_recargos: true, notas: 'Convenio de regularización' });
    assert.ok(conv.monto_cents > 0);
    await C.admin.ok('POST', a('/descuentos/lote'), { periodo: M, pct_bp: 200, motivo: 'Descuento de asamblea' });
    assert.equal(await foto(C), fotos.get(C.id), `${C.nombre}: los reportes de meses cerrados no cambian`);
    // la reapertura es solo del superadministrador y del último mes cerrado
    assert.equal((await C.admin.post(a(`/periodos/${M2}/reabrir`), { motivo: 'x' })).status, 403);
    assert.equal((await sup.post(a(`/periodos/${M3}/reabrir`), { motivo: 'x' })).status, 409);
  }));
  for (const C of CONDOS) await cuadres(C, 'tras correcciones');
  // el recibo cancelado resta en el mes en curso, no en el mes cerrado
  const C = CONDOS[0], ing = await C.admin.ok('GET', `/api/c/${C.id}/reportes/ingresos?anio=${M.slice(0, 4)}&mes=${+M.slice(5)}`);
  assert.equal(ing.cancelados.n, 1); assert.equal(ing.cancelados.monto, C.pagosM3[0].monto);
});

test('ráfagas simultáneas: sin duplicados ni folios repetidos', async () => {
  const C = CONDOS[1], a = p => `/api/c/${C.id}${p}`, us = C.unidades;
  const antes = db.prepare('SELECT COUNT(*) n FROM pagos WHERE condominio_id = ?').get(C.id).n;
  const key = idem();
  const cuerpo = { unidad_id: us[10].id, fecha: HOY, monto_cents: 150000, metodo: 'efectivo', idem_key: key, confirmar_duplicado: true };
  const mismos = await Promise.all(Array.from({ length: 12 }, () => C.cont.post(a('/pagos'), cuerpo)));       // doble clic / reintentos de red
  assert.ok(mismos.every(r => r.status === 200));
  assert.equal(new Set(mismos.map(r => r.json.folio)).size, 1, 'los reintentos devuelven el mismo recibo');
  const distintos = await Promise.all(us.slice(11, 26).map((u, i) => C.cont.post(a('/pagos'), { unidad_id: u.id, fecha: HOY, monto_cents: 10000 + i, metodo: 'efectivo', idem_key: idem(), confirmar_duplicado: true })));
  assert.ok(distintos.every(r => r.status === 200));
  assert.equal(new Set(distintos.map(r => r.json.folio)).size, 15, 'cada pago con su folio');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pagos WHERE condominio_id = ?').get(C.id).n, antes + 16);
  // misma referencia bancaria e importe: solo uno entra
  const ref = { unidad_id: us[12].id, fecha: HOY, monto_cents: 222200, metodo: 'transferencia', cuenta_banco_id: C.bOp, referencia: 'RASTREO-UNICO-1', confirmar_duplicado: true };
  const dup = await Promise.all(Array.from({ length: 6 }, () => C.cont.post(a('/pagos'), { ...ref, idem_key: idem() })));
  assert.equal(dup.filter(r => r.status === 200).length, 1);
  assert.equal(dup.filter(r => r.status === 409).length, 5);
  // dos administradores de condominios distintos trabajan al mismo tiempo
  await Promise.all(CONDOS.flatMap(X => Array.from({ length: 8 }, (_, i) => X.cont.post(`/api/c/${X.id}/gestiones`, { unidad_id: X.unidades[i % X.unidades.length].id, tipo: 'llamada', nota: `Seguimiento ${i}` }))));
  for (const X of CONDOS) assert.equal((await X.admin.ok('GET', `/api/c/${X.id}/integridad`)).ok, true);
  assert.equal(verifyAuditChain(db).ok, true, 'la bitácora encadenada resiste escrituras simultáneas');
  await cuadres(C, 'tras ráfagas');
});
