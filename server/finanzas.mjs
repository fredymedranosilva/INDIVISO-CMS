// Motor financiero: partida doble, cobranza, egresos, conciliación, presupuesto y cierres.
// Todas las funciones que escriben deben ejecutarse dentro de tx() (ver db.mjs).
import { fail, hoy, periodoDe, addMonths, addDays, diffDays, nombrePeriodo, prorratear, mask } from './util.mjs';
import { token, sha256 } from './security.mjs';

// ---------- Catálogo de cuentas base ----------
export const CATALOGO = [
  ['1101', 'Caja', 'activo', 'D', 'CAJA', 0],
  ['1201', 'Cuotas por cobrar a condóminos', 'activo', 'D', 'CXC', 0],
  ['2101', 'Proveedores por pagar', 'pasivo', 'A', 'CXP', 0],
  ['2102', 'Anticipos y saldos a favor de condóminos', 'pasivo', 'A', 'ANTICIPOS', 0],
  ['3101', 'Fondo de reserva', 'patrimonio', 'A', 'FONDO_RESERVA', 0],
  ['3201', 'Remanente de ejercicios anteriores', 'patrimonio', 'A', 'REMANENTE', 0],
  ['4101', 'Cuotas ordinarias de mantenimiento', 'ingreso', 'A', 'ING_ORD', 0],
  ['4102', 'Cuotas extraordinarias', 'ingreso', 'A', 'ING_EXT', 0],
  ['4103', 'Recargos por mora', 'ingreso', 'A', 'ING_REC', 0],
  ['4104', 'Multas y sanciones', 'ingreso', 'A', 'ING_MULTA', 0],
  ['4105', 'Otros ingresos', 'ingreso', 'A', 'ING_OTRO', 0],
  ['4190', 'Bonificaciones y condonaciones', 'ingreso', 'D', 'BONIF', 0],
  ['5101', 'Energía eléctrica', 'egreso', 'D', null, 1],
  ['5102', 'Agua potable', 'egreso', 'D', null, 1],
  ['5103', 'Gas', 'egreso', 'D', null, 1],
  ['5201', 'Seguridad y vigilancia', 'egreso', 'D', null, 1],
  ['5202', 'Limpieza', 'egreso', 'D', null, 1],
  ['5203', 'Jardinería', 'egreso', 'D', null, 1],
  ['5301', 'Mantenimiento de elevadores', 'egreso', 'D', null, 1],
  ['5302', 'Mantenimiento general y reparaciones', 'egreso', 'D', null, 1],
  ['5303', 'Equipos hidráulicos y bombas', 'egreso', 'D', null, 1],
  ['5401', 'Honorarios de administración', 'egreso', 'D', null, 1],
  ['5402', 'Honorarios contables y legales', 'egreso', 'D', null, 1],
  ['5403', 'Nómina y seguridad social', 'egreso', 'D', null, 1],
  ['5501', 'Seguros del inmueble', 'egreso', 'D', null, 1],
  ['5502', 'Comisiones bancarias', 'egreso', 'D', null, 1],
  ['5503', 'Papelería y gastos de oficina', 'egreso', 'D', null, 1],
  ['5590', 'Otros gastos', 'egreso', 'D', null, 1],
];

const CUENTA_CARGO = { ordinaria: 'ING_ORD', extraordinaria: 'ING_EXT', recargo: 'ING_REC', multa: 'ING_MULTA', otro: 'ING_OTRO' };

export function crearCondominio(db, data, user) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO condominios (nombre, razon_social, rfc, direccion, ciudad, dia_vencimiento, dias_gracia,
    tasa_recargo_bp, pct_reserva_bp, umbral_aprobacion_cents, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    data.nombre, data.razon_social ?? null, data.rfc ?? null, data.direccion ?? null, data.ciudad ?? null,
    data.dia_vencimiento ?? 10, data.dias_gracia ?? 0, data.tasa_recargo_bp ?? 300, data.pct_reserva_bp ?? 1000,
    data.umbral_aprobacion_cents ?? 1000000, now);
  const cid = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, clave, presupuestable) VALUES (?,?,?,?,?,?,?)');
  for (const [codigo, nombre, tipo, nat, clave, pres] of CATALOGO) ins.run(cid, codigo, nombre, tipo, nat, clave, pres);
  return cid;
}

export function cuenta(db, cid, clave) {
  const r = db.prepare('SELECT id FROM cuentas WHERE condominio_id = ? AND clave = ?').get(cid, clave);
  if (!r) fail(500, `Cuenta de sistema ${clave} inexistente`);
  return r.id;
}
export const condo = (db, cid) => db.prepare('SELECT * FROM condominios WHERE id = ?').get(cid) || fail(404, 'Condominio no encontrado');
function unidadDe(db, cid, uid) {
  const u = db.prepare('SELECT * FROM unidades WHERE id = ? AND condominio_id = ?').get(uid, cid);
  if (!u) fail(404, 'Unidad no encontrada');
  return u;
}

export function periodoAbierto(db, cid, periodo) {
  const p = db.prepare('SELECT estado FROM periodos WHERE condominio_id = ? AND periodo = ?').get(cid, periodo);
  return !p || p.estado === 'abierto';
}
// Si la fecha cae en un periodo cerrado, el registro contable se hace hoy (nunca se altera un mes cerrado).
export function fechaContable(db, cid, fecha) {
  if (periodoAbierto(db, cid, periodoDe(fecha))) return fecha;
  const h = hoy();
  if (!periodoAbierto(db, cid, periodoDe(h))) fail(409, 'El periodo actual está cerrado; no es posible registrar.', 'PERIODO_CERRADO');
  return h;
}

// ---------- Pólizas (partida doble) ----------
export function crearPoliza(db, cid, { tipo = 'D', fecha, concepto, origen, origen_id = null, reversa_de = null, lineas }, user) {
  const ls = lineas.filter(l => (l.debe || 0) > 0 || (l.haber || 0) > 0);
  if (!ls.length) fail(400, 'La póliza no tiene movimientos.');
  let debe = 0, haber = 0;
  const cuentaOk = db.prepare('SELECT 1 FROM cuentas WHERE id = ? AND condominio_id = ? AND activo = 1');
  for (const l of ls) {
    const d = l.debe || 0, h = l.haber || 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(h) || d < 0 || h < 0 || (d > 0 && h > 0)) fail(400, 'Movimiento contable inválido.');
    if (!cuentaOk.get(l.cuenta, cid)) fail(400, 'Cuenta contable inválida para este condominio.');
    debe += d; haber += h;
  }
  if (debe !== haber) fail(400, `Póliza descuadrada: cargos ${debe} ≠ abonos ${haber}.`);
  const periodo = periodoDe(fecha);
  db.prepare("INSERT OR IGNORE INTO periodos (condominio_id, periodo, estado) VALUES (?, ?, 'abierto')").run(cid, periodo);
  const folio = db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM polizas WHERE condominio_id = ? AND tipo = ?').get(cid, tipo).f;
  const r = db.prepare(`INSERT INTO polizas (condominio_id, tipo, folio, fecha, periodo, concepto, origen, origen_id, reversa_de, total_cents, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(cid, tipo, folio, fecha, periodo, concepto, origen, origen_id, reversa_de, debe, user?.id ?? null, Date.now());
  const pid = Number(r.lastInsertRowid);
  const im = db.prepare('INSERT INTO movimientos (poliza_id, cuenta_id, unidad_id, debe_cents, haber_cents, concepto) VALUES (?,?,?,?,?,?)');
  for (const l of ls) im.run(pid, l.cuenta, l.unidad ?? null, l.debe || 0, l.haber || 0, l.concepto ?? null);
  return pid;
}

export function polizaManual(db, cid, data, user) {
  const prohibidas = new Set([cuenta(db, cid, 'CXC'), cuenta(db, cid, 'ANTICIPOS')]);
  for (const l of data.lineas) {
    if (prohibidas.has(l.cuenta)) fail(400, 'Las cuentas de condóminos solo se afectan desde Cobranza (mantiene cuadrados los estados de cuenta).');
  }
  return crearPoliza(db, cid, { tipo: data.tipo, fecha: data.fecha, concepto: data.concepto, origen: 'manual', lineas: data.lineas }, user);
}

export function revertirPoliza(db, cid, polizaId, motivo, user) {
  const p = db.prepare('SELECT * FROM polizas WHERE id = ? AND condominio_id = ?').get(polizaId, cid) || fail(404, 'Póliza no encontrada');
  if (p.origen !== 'manual') fail(400, 'Solo las pólizas manuales se revierten aquí; las automáticas se revierten cancelando su documento de origen.');
  if (p.reversada_por) fail(409, 'La póliza ya fue revertida.');
  const movs = db.prepare('SELECT * FROM movimientos WHERE poliza_id = ?').all(polizaId);
  const nid = crearPoliza(db, cid, {
    tipo: 'D', fecha: fechaContable(db, cid, hoy()), concepto: `Reversa de ${p.tipo}-${p.folio}: ${motivo}`, origen: 'reverso', reversa_de: p.id,
    lineas: movs.map(m => ({ cuenta: m.cuenta_id, unidad: m.unidad_id, debe: m.haber_cents, haber: m.debe_cents, concepto: m.concepto })),
  }, user);
  db.prepare('UPDATE polizas SET reversada_por = ? WHERE id = ?').run(nid, p.id);
  return nid;
}

// ---------- Cargos y saldos ----------
const SALDO_CARGO = `c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0)`;

export function cargosAbiertos(db, unidadId) {
  return db.prepare(`SELECT c.*, ${SALDO_CARGO} AS saldo_cents FROM cargos c
    WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND ${SALDO_CARGO} > 0
    ORDER BY c.vencimiento, CASE c.tipo WHEN 'recargo' THEN 0 ELSE 1 END, c.id`).all(unidadId);
}
export function creditosDisponibles(db, unidadId) {
  return db.prepare(`SELECT p.id, p.fecha, p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0) AS libre
    FROM pagos p WHERE p.unidad_id = ? AND p.estado = 'aplicado' ORDER BY p.fecha, p.id`).all(unidadId).filter(r => r.libre > 0);
}

// Prelación: lo más antiguo primero; a igual vencimiento, recargos antes que cuotas.
function planAplicacion(abiertos, monto) {
  const plan = []; let resto = monto;
  for (const c of abiertos) {
    if (resto <= 0) break;
    const m = Math.min(resto, c.saldo_cents);
    plan.push({ cargo_id: c.id, monto: m }); resto -= m;
  }
  return { plan, resto };
}

const insAplic = (db, cid, a, user) => db.prepare(`INSERT INTO aplicaciones (condominio_id, cargo_id, pago_id, tipo, monto_cents, motivo, poliza_id, created_by, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(cid, a.cargo_id, a.pago_id ?? null, a.tipo, a.monto, a.motivo ?? null, a.poliza_id, user?.id ?? null, Date.now());

// Aplica saldos a favor (anticipos) a cargos abiertos de una unidad.
export function aplicarSaldoFavor(db, cid, unidadId, fecha, user) {
  const creditos = creditosDisponibles(db, unidadId);
  if (!creditos.length) return 0;
  let abiertos = cargosAbiertos(db, unidadId);
  if (!abiertos.length) return 0;
  const pares = [];
  for (const cr of creditos) {
    const { plan } = planAplicacion(abiertos, cr.libre);
    for (const p of plan) {
      pares.push({ ...p, pago_id: cr.id });
      const c = abiertos.find(x => x.id === p.cargo_id); c.saldo_cents -= p.monto;
    }
    abiertos = abiertos.filter(c => c.saldo_cents > 0);
    if (!abiertos.length) break;
  }
  const total = pares.reduce((a, p) => a + p.monto, 0);
  if (!total) return 0;
  const u = unidadDe(db, cid, unidadId);
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha, concepto: `Aplicación de saldo a favor · ${u.clave}`, origen: 'aplicacion_anticipo', origen_id: unidadId,
    lineas: [
      { cuenta: cuenta(db, cid, 'ANTICIPOS'), unidad: unidadId, debe: total, concepto: 'Aplicación de saldo a favor' },
      { cuenta: cuenta(db, cid, 'CXC'), unidad: unidadId, haber: total, concepto: 'Aplicación de saldo a favor' },
    ],
  }, user);
  for (const p of pares) insAplic(db, cid, { ...p, tipo: 'pago', poliza_id: pid }, user);
  return total;
}

function insertarCargos(db, cid, cargos, { concepto, fecha, origen }, user) {
  // cargos: [{unidad, tipo, concepto, periodo, vencimiento, monto, reserva, dedupe, lote}]
  const existe = db.prepare('SELECT 1 FROM cargos WHERE dedupe_key = ?');
  const nuevos = cargos.filter(c => c.monto > 0 && !existe.get(c.dedupe));
  if (!nuevos.length) return { emitidos: 0, omitidos: cargos.length, total: 0 };
  const cxc = cuenta(db, cid, 'CXC'), res = cuenta(db, cid, 'FONDO_RESERVA');
  const porCuenta = new Map(), porFondo = new Map();
  const lineas = nuevos.map(c => {
    const ci = cuenta(db, cid, c.cuentaClave || CUENTA_CARGO[c.tipo]);
    c.cuenta = ci;
    porCuenta.set(ci, (porCuenta.get(ci) || 0) + c.monto - c.reserva);
    const f = c.fondoCuenta || res;
    porFondo.set(f, (porFondo.get(f) || 0) + c.reserva);
    return { cuenta: cxc, unidad: c.unidad, debe: c.monto, concepto: c.concepto };
  });
  for (const [ci, m] of porCuenta) if (m > 0) lineas.push({ cuenta: ci, haber: m, concepto });
  for (const [f, m] of porFondo) if (m > 0) lineas.push({ cuenta: f, haber: m, concepto: `${concepto} · aportación a ${f === res ? 'fondo de reserva' : 'fondo'}` });
  const pid = crearPoliza(db, cid, { tipo: 'D', fecha, concepto, origen, lineas }, user);
  const ins = db.prepare(`INSERT INTO cargos (condominio_id, unidad_id, tipo, concepto, periodo, fecha, vencimiento, monto_cents, reserva_cents,
    cuenta_ingreso_id, poliza_id, lote, dedupe_key, fondo_cuenta_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of nuevos) ins.run(cid, c.unidad, c.tipo, c.concepto, c.periodo, fecha, c.vencimiento, c.monto, c.reserva, c.cuenta, pid, c.lote ?? null, c.dedupe, c.reserva && c.fondoCuenta ? c.fondoCuenta : null, user?.id ?? null, Date.now());
  for (const uid of new Set(nuevos.map(c => c.unidad))) aplicarSaldoFavor(db, cid, uid, fecha, user);
  return { emitidos: nuevos.length, omitidos: cargos.length - nuevos.length, total: nuevos.reduce((a, c) => a + c.monto, 0), poliza_id: pid };
}

const vencimientoDe = (c, periodo) => `${periodo}-${String(c.dia_vencimiento).padStart(2, '0')}`;

export function emitirCuotas(db, cid, periodo, user, fecha = `${periodo}-01`) {
  const c = condo(db, cid);
  const unidades = db.prepare('SELECT * FROM unidades WHERE condominio_id = ? AND activo = 1 AND cuota_cents > 0 ORDER BY clave').all(cid);
  const recurrentes = cargosRecurrentesDe(db, cid, periodo);
  if (!unidades.length && !recurrentes.length) fail(400, 'No hay unidades activas con cuota asignada.');
  const concepto = `Cuota ordinaria ${nombrePeriodo(periodo)}`;
  return insertarCargos(db, cid, [...unidades.map(u => ({
    unidad: u.id, tipo: 'ordinaria', concepto, periodo, vencimiento: vencimientoDe(c, periodo), monto: u.cuota_cents,
    reserva: Math.round(u.cuota_cents * c.pct_reserva_bp / 10000), dedupe: `ORD:${u.id}:${periodo}`,
  })), ...recurrentes.map(r => ({ ...r, vencimiento: vencimientoDe(c, periodo) }))], { concepto: `Emisión de cuotas ordinarias · ${nombrePeriodo(periodo)}`, fecha, origen: 'emision' }, user);
}

// Adeudos recurrentes: cargos fijos que se emiten cada mes junto con la cuota ordinaria
// (estacionamiento adicional, bodega, cuota de subsidio, extraordinaria en mensualidades...).
export function cargosRecurrentesDe(db, cid, periodo) {
  const rs = db.prepare(`SELECT * FROM cargos_recurrentes WHERE condominio_id = ? AND activo = 1 AND desde <= ? AND (hasta IS NULL OR hasta >= ?)`).all(cid, periodo, periodo);
  const activas = db.prepare('SELECT id FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave').all(cid).map(u => u.id);
  const out = [];
  for (const r of rs) for (const uid of r.unidad_id ? [r.unidad_id].filter(x => activas.includes(x)) : activas)
    out.push({ unidad: uid, tipo: r.tipo, concepto: `${r.concepto} ${nombrePeriodo(periodo)}`, periodo, monto: r.monto_cents, reserva: 0, dedupe: `RCU:${r.id}:${uid}:${periodo}` });
  return out;
}

export function crearCargoRecurrente(db, cid, d, user) {
  if (d.unidad_id) unidadDe(db, cid, d.unidad_id);
  if (d.hasta && d.hasta < d.desde) fail(400, 'El periodo final es anterior al inicial.');
  return Number(db.prepare('INSERT INTO cargos_recurrentes (condominio_id, unidad_id, tipo, concepto, monto_cents, desde, hasta, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(cid, d.unidad_id ?? null, d.tipo, d.concepto, d.monto_cents, d.desde, d.hasta ?? null, user?.id ?? null, Date.now()).lastInsertRowid);
}

// ---------- Fondos (además del fondo de reserva) ----------
export function crearFondo(db, cid, d, user) {
  if (db.prepare('SELECT 1 FROM fondos WHERE condominio_id = ? AND nombre = ? COLLATE NOCASE').get(cid, d.nombre)) fail(409, 'Ya existe un fondo con ese nombre.', 'DUPLICADO');
  const n = db.prepare("SELECT COUNT(*) n FROM cuentas WHERE condominio_id = ? AND codigo LIKE '3102-%'").get(cid).n + 1;
  const k = Number(db.prepare("INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza) VALUES (?,?,?,'patrimonio','A')").run(cid, `3102-${String(n).padStart(2, '0')}`, `Fondo · ${d.nombre}`).lastInsertRowid);
  return Number(db.prepare('INSERT INTO fondos (condominio_id, nombre, cuenta_id, meta_cents, descripcion, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, d.nombre, k, d.meta_cents ?? null, d.descripcion ?? null, user?.id ?? null, Date.now()).lastInsertRowid);
}
const fondoDe = (db, cid, id) => db.prepare('SELECT * FROM fondos WHERE id = ? AND condominio_id = ? AND activo = 1').get(id, cid) || fail(400, 'Fondo inválido.');

export function emitirExtraordinaria(db, cid, d, user) {
  const c = condo(db, cid);
  const fondo = d.destino === 'fondo' ? fondoDe(db, cid, d.fondo_id) : null;
  let unidades = db.prepare('SELECT * FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave').all(cid);
  if (d.unidades?.length) { const s = new Set(d.unidades.map(Number)); unidades = unidades.filter(u => s.has(u.id)); }
  if (!unidades.length) fail(400, 'Seleccione al menos una unidad.');
  const pesos = d.metodo === 'igual' ? unidades.map(() => 1) : unidades.map(u => u.indiviso_ppm);
  const partes = prorratear(d.total_cents, pesos);
  const lote = 'EXT-' + token(6);
  const periodo = periodoDe(d.fecha);
  return { lote, ...insertarCargos(db, cid, unidades.map((u, i) => ({
    unidad: u.id, tipo: 'extraordinaria', concepto: d.concepto, periodo, vencimiento: d.vencimiento || vencimientoDe(c, periodo),
    monto: partes[i], reserva: d.destino !== 'operacion' ? partes[i] : 0, fondoCuenta: fondo?.cuenta_id, dedupe: `EXT:${lote}:${u.id}`, lote,
  })), { concepto: `Cuota extraordinaria · ${d.concepto}`, fecha: d.fecha, origen: 'extraordinaria' }, user) };
}

export function cargoIndividual(db, cid, d, user) {
  unidadDe(db, cid, d.unidad_id);
  return insertarCargos(db, cid, [{
    unidad: d.unidad_id, tipo: d.tipo, concepto: d.concepto, periodo: periodoDe(d.fecha), vencimiento: d.vencimiento || d.fecha,
    monto: d.monto_cents, reserva: 0, dedupe: `IND:${token(9)}`,
  }], { concepto: d.concepto, fecha: d.fecha, origen: 'cargo' }, user);
}

// Recargos del mes sobre cuotas vencidas (nunca sobre recargos: sin anatocismo). Tres modos:
//   saldo: % sobre el saldo vencido · cuota: % sobre el importe de cada cuota vencida · fijo: monto por cada cuota vencida.
export function calcularRecargos(db, cid, periodo, user) {
  const c = condo(db, cid);
  const modo = c.recargo_modo || 'saldo';
  if (modo === 'fijo' ? !c.recargo_fijo_cents : !c.tasa_recargo_bp) fail(400, modo === 'fijo' ? 'El recargo fijo está en $0.' : 'La tasa de recargos está en 0%.');
  const corte = `${periodo}-01`;
  const conv = new Set(db.prepare("SELECT unidad_id FROM convenios WHERE condominio_id = ? AND estado = 'vigente' AND suspende_recargos = 1").all(cid).map(r => r.unidad_id));
  const rows = db.prepare(`SELECT c.unidad_id, c.vencimiento, c.monto_cents, ${SALDO_CARGO} AS saldo FROM cargos c
    WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.tipo IN ('ordinaria','extraordinaria')`).all(cid);
  const porUnidad = new Map();
  for (const r of rows) {
    if (r.saldo <= 0 || addDays(r.vencimiento, c.dias_gracia) >= corte || conv.has(r.unidad_id)) continue;
    const u = porUnidad.get(r.unidad_id) || { saldo: 0, cuotas: 0, base: 0 };
    u.saldo += r.saldo; u.cuotas++; u.base += r.monto_cents;
    porUnidad.set(r.unidad_id, u);
  }
  const pct = (c.tasa_recargo_bp / 100).toFixed(2).replace(/\.00$/, '');
  const calc = u => modo === 'fijo' ? u.cuotas * c.recargo_fijo_cents : Math.round((modo === 'cuota' ? u.base : u.saldo) * c.tasa_recargo_bp / 10000);
  const texto = u => modo === 'fijo' ? `Recargo fijo ${nombrePeriodo(periodo)} · ${u.cuotas} ${u.cuotas === 1 ? 'cuota vencida' : 'cuotas vencidas'}`
    : modo === 'cuota' ? `Recargo ${pct}% sobre ${u.cuotas === 1 ? 'la cuota vencida' : `${u.cuotas} cuotas vencidas`} ${nombrePeriodo(periodo)}` : `Recargo ${pct}% ${nombrePeriodo(periodo)} sobre saldo vencido`;
  return insertarCargos(db, cid, [...porUnidad].map(([uid, u]) => ({
    unidad: uid, tipo: 'recargo', concepto: texto(u), periodo,
    vencimiento: vencimientoDe(c, periodo), monto: calc(u), reserva: 0, dedupe: `REC:${uid}:${periodo}`,
  })), { concepto: `Recargos por mora · ${nombrePeriodo(periodo)}`, fecha: corte, origen: 'recargos' }, user);
}

// Recargo a una cuota específica: porcentaje sobre su importe o monto fijo. Uno por cuota y mes.
export function recargoManual(db, cid, d, user) {
  const cg = db.prepare(`SELECT c.*, ${SALDO_CARGO} AS saldo FROM cargos c WHERE c.id = ? AND c.condominio_id = ?`).get(d.cargo_id, cid) || fail(404, 'Cuota no encontrada.');
  if (cg.cancelado_at) fail(409, 'La cuota está cancelada.');
  if (!['ordinaria', 'extraordinaria', 'otro'].includes(cg.tipo)) fail(400, 'Solo se aplican recargos a cuotas (no a otros recargos).');
  const monto = d.modo === 'porcentaje' ? Math.round(cg.monto_cents * d.porcentaje_bp / 10000) : d.monto_cents;
  if (!(monto > 0)) fail(400, 'El recargo debe ser mayor a cero.');
  const periodo = periodoDe(d.fecha);
  const concepto = (d.concepto || (d.modo === 'porcentaje' ? `Recargo ${(d.porcentaje_bp / 100).toFixed(2).replace(/\.00$/, '')}% sobre ${cg.concepto}` : `Recargo sobre ${cg.concepto}`)).slice(0, 120);
  const r = insertarCargos(db, cid, [{ unidad: cg.unidad_id, tipo: 'recargo', concepto, periodo, vencimiento: d.fecha, monto, reserva: 0, dedupe: `RECM:${cg.id}:${periodo}` }],
    { concepto, fecha: d.fecha, origen: 'recargos' }, user);
  if (!r.emitidos) fail(409, 'Esa cuota ya tiene un recargo aplicado este mes.', 'DUPLICADO');
  return { ...r, monto };
}

export function bonificar(db, cid, cargoId, monto, motivo, user, fechaAplica = null) {
  const c = db.prepare(`SELECT c.*, ${SALDO_CARGO} AS saldo_cents FROM cargos c WHERE c.id = ? AND c.condominio_id = ?`).get(cargoId, cid) || fail(404, 'Cargo no encontrado');
  if (c.cancelado_at) fail(409, 'El cargo está cancelado.');
  if (monto > c.saldo_cents) fail(400, 'La bonificación excede el saldo del cargo.');
  const resPart = Math.round(monto * c.reserva_cents / c.monto_cents);
  const fecha = fechaContable(db, cid, fechaAplica || hoy());
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha, concepto: `Bonificación: ${c.concepto} · ${motivo}`, origen: 'bonificacion', origen_id: c.id,
    lineas: [
      { cuenta: cuenta(db, cid, 'BONIF'), debe: monto - resPart, concepto: motivo },
      { cuenta: c.fondo_cuenta_id || cuenta(db, cid, 'FONDO_RESERVA'), debe: resPart, concepto: motivo },
      { cuenta: cuenta(db, cid, 'CXC'), unidad: c.unidad_id, haber: monto, concepto: `${motivo === MOTIVO_PRONTO_PAGO ? MOTIVO_PRONTO_PAGO : 'Bonificación'}: ${c.concepto}` },
    ],
  }, user);
  insAplic(db, cid, { cargo_id: c.id, tipo: 'bonificacion', monto, motivo, poliza_id: pid }, user);
  return pid;
}

export function cancelarCargo(db, cid, cargoId, motivo, user) {
  const c = db.prepare('SELECT * FROM cargos WHERE id = ? AND condominio_id = ?').get(cargoId, cid) || fail(404, 'Cargo no encontrado');
  if (c.cancelado_at) fail(409, 'El cargo ya está cancelado.');
  const apl = db.prepare('SELECT COUNT(*) n FROM aplicaciones WHERE cargo_id = ? AND revertida = 0').get(c.id).n;
  if (apl) fail(409, 'El cargo tiene pagos o bonificaciones aplicados; cancele primero esos movimientos o use bonificación.');
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha: fechaContable(db, cid, hoy()), concepto: `Cancelación de cargo: ${c.concepto} · ${motivo}`, origen: 'cancelacion_cargo', origen_id: c.id,
    lineas: [
      { cuenta: c.cuenta_ingreso_id, debe: c.monto_cents - c.reserva_cents, concepto: motivo },
      { cuenta: c.fondo_cuenta_id || cuenta(db, cid, 'FONDO_RESERVA'), debe: c.reserva_cents, concepto: motivo },
      { cuenta: cuenta(db, cid, 'CXC'), unidad: c.unidad_id, haber: c.monto_cents, concepto: `Cancelación: ${c.concepto}` },
    ],
  }, user);
  db.prepare('UPDATE cargos SET cancelado_at = ?, cancelado_por = ?, motivo_cancel = ?, cancel_poliza_id = ? WHERE id = ?').run(Date.now(), user?.id ?? null, motivo, pid, c.id);
  return pid;
}

// ---------- Pagos ----------
// Saldo a favor inicial (migración): pago sin movimiento de efectivo, contra el patrimonio.
export const esSaldoInicial = p => typeof p?.idem_key === 'string' && p.idem_key.startsWith('INI-');

function cuentaDeCobro(db, cid, pago) {
  if (esSaldoInicial(pago)) return cuenta(db, cid, 'REMANENTE');
  if (pago.cuenta_banco_id) {
    const b = db.prepare('SELECT cuenta_id FROM cuentas_banco WHERE id = ? AND condominio_id = ? AND activo = 1').get(pago.cuenta_banco_id, cid);
    if (!b) fail(400, 'Cuenta bancaria inválida.');
    return b.cuenta_id;
  }
  if (pago.metodo !== 'efectivo') fail(400, 'Indique la cuenta bancaria donde se recibió el pago.');
  return cuenta(db, cid, 'CAJA');
}

export function posiblesDuplicados(db, cid, d) {
  return db.prepare(`SELECT id, folio, fecha, monto_cents, referencia, estado FROM pagos WHERE condominio_id = ? AND unidad_id = ? AND monto_cents = ?
    AND estado IN ('por_validar','aplicado') AND ABS(julianday(fecha) - julianday(?)) <= 3`).all(cid, d.unidad_id, d.monto_cents, d.fecha);
}

// Descuento por pronto pago: si el pago (por su fecha) llega a tiempo y alcanza para liquidar la cuota
// ordinaria completa menos el descuento, la diferencia se registra como bonificación antes de aplicar el pago.
export const MOTIVO_PRONTO_PAGO = 'Descuento por pronto pago';
function descuentoProntoPago(db, cid, u, pago, fecha, user) {
  const c = condo(db, cid);
  if (!c.pronto_pago_bp || !c.pronto_pago_dia) return 0;
  const ya = db.prepare("SELECT 1 FROM aplicaciones WHERE cargo_id = ? AND tipo = 'bonificacion' AND revertida = 0 AND motivo = ?");
  let resto = pago.monto_cents, total = 0;
  for (const cg of cargosAbiertos(db, u.id)) {
    if (resto <= 0) break;
    const limite = `${cg.periodo}-${String(c.pronto_pago_dia).padStart(2, '0')}`;
    const elegible = cg.tipo === 'ordinaria' && cg.saldo_cents === cg.monto_cents && pago.fecha <= limite && !ya.get(cg.id, MOTIVO_PRONTO_PAGO);
    const desc = elegible ? Math.round(cg.monto_cents * c.pronto_pago_bp / 10000) : 0;
    if (desc > 0 && resto >= cg.saldo_cents - desc) {
      bonificar(db, cid, cg.id, desc, MOTIVO_PRONTO_PAGO, user, fecha);
      resto -= cg.saldo_cents - desc; total += desc;
    } else resto -= Math.min(resto, cg.saldo_cents);
  }
  return total;
}

function contabilizarPago(db, cid, pago, user) {
  const u = unidadDe(db, cid, pago.unidad_id);
  const fecha = fechaContable(db, cid, pago.fecha);
  const descuento = descuentoProntoPago(db, cid, u, pago, fecha, user);
  const { plan, resto } = planAplicacion(cargosAbiertos(db, u.id), pago.monto_cents);
  const aplicado = pago.monto_cents - resto;
  const folio = pago.folio ?? db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 f FROM pagos WHERE condominio_id = ?').get(cid).f;
  const ref = pago.referencia ? ` ref. ${pago.referencia}` : '';
  const pid = crearPoliza(db, cid, {
    tipo: 'I', fecha, concepto: `Cobro recibo R-${folio} · ${u.clave} · ${pago.metodo}${ref}`, origen: 'pago', origen_id: pago.id,
    lineas: [
      { cuenta: cuentaDeCobro(db, cid, pago), debe: pago.monto_cents, concepto: `Cobro ${u.clave}` },
      { cuenta: cuenta(db, cid, 'CXC'), unidad: u.id, haber: aplicado, concepto: `Pago recibo R-${folio}${ref}` },
      { cuenta: cuenta(db, cid, 'ANTICIPOS'), unidad: u.id, haber: resto, concepto: `Saldo a favor · recibo R-${folio}` },
    ],
  }, user);
  for (const p of plan) insAplic(db, cid, { ...p, pago_id: pago.id, tipo: 'pago', poliza_id: pid }, user);
  db.prepare("UPDATE pagos SET estado = 'aplicado', folio = ?, poliza_id = ?, validado_por = ?, validado_at = ? WHERE id = ?").run(folio, pid, user?.id ?? null, Date.now(), pago.id);
  return { folio, aplicado, saldo_favor: resto, descuento };
}

export function registrarPago(db, cid, d, user, { validar = true } = {}) {
  const prev = db.prepare('SELECT * FROM pagos WHERE idem_key = ?').get(d.idem_key);
  if (prev) { // reintento de la misma operación: se devuelve el resultado original
    if (prev.condominio_id !== cid) fail(409, 'Clave de operación duplicada.');
    return { id: prev.id, folio: prev.folio, estado: prev.estado, repetido: true };
  }
  unidadDe(db, cid, d.unidad_id);
  if (d.cuenta_banco_id && d.referencia) {
    const dup = db.prepare(`SELECT folio FROM pagos WHERE condominio_id = ? AND cuenta_banco_id = ? AND referencia = ? AND monto_cents = ? AND estado IN ('por_validar','aplicado')`).get(cid, d.cuenta_banco_id, d.referencia, d.monto_cents);
    if (dup) fail(409, `Ya existe un pago con la misma referencia bancaria e importe${dup.folio ? ` (recibo R-${dup.folio})` : ''}.`, 'DUPLICADO');
  }
  if (!d.confirmar_duplicado && posiblesDuplicados(db, cid, d).length) fail(409, 'Existe un pago de la misma unidad y monto en un rango de ±3 días. Confirme si no es duplicado.', 'POSIBLE_DUPLICADO');
  const r = db.prepare(`INSERT INTO pagos (condominio_id, unidad_id, fecha, monto_cents, metodo, referencia, cuenta_banco_id, comprobante_id, estado, idem_key, notas, reportado_por, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(cid, d.unidad_id, d.fecha, d.monto_cents, d.metodo, d.referencia ?? null, d.cuenta_banco_id ?? null,
    d.comprobante_id ?? null, 'por_validar', d.idem_key, d.notas ?? null, validar ? null : user?.id ?? null, user?.id ?? null, Date.now());
  const pago = db.prepare('SELECT * FROM pagos WHERE id = ?').get(Number(r.lastInsertRowid));
  if (!validar) return { id: pago.id, estado: 'por_validar' };
  return { id: pago.id, estado: 'aplicado', ...contabilizarPago(db, cid, pago, user) };
}

export function validarPago(db, cid, pagoId, d, user) {
  const p = db.prepare('SELECT * FROM pagos WHERE id = ? AND condominio_id = ?').get(pagoId, cid) || fail(404, 'Pago no encontrado');
  if (p.estado !== 'por_validar') fail(409, 'El pago ya fue procesado.');
  if (d.aceptar) {
    if (d.cuenta_banco_id) db.prepare('UPDATE pagos SET cuenta_banco_id = ? WHERE id = ?').run(d.cuenta_banco_id, p.id);
    return contabilizarPago(db, cid, db.prepare('SELECT * FROM pagos WHERE id = ?').get(p.id), user);
  }
  db.prepare("UPDATE pagos SET estado = 'rechazado', motivo = ?, validado_por = ?, validado_at = ? WHERE id = ?").run(d.motivo || 'Rechazado', user.id, Date.now(), p.id);
  return { rechazado: true };
}

export function cancelarPago(db, cid, pagoId, motivo, user) {
  const p = db.prepare('SELECT * FROM pagos WHERE id = ? AND condominio_id = ?').get(pagoId, cid) || fail(404, 'Pago no encontrado');
  if (p.estado === 'por_validar') { db.prepare("UPDATE pagos SET estado = 'rechazado', motivo = ? WHERE id = ?").run(motivo, p.id); return {}; }
  if (p.estado !== 'aplicado') fail(409, 'El pago ya está cancelado o rechazado.');
  const aplicado = db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM aplicaciones WHERE pago_id = ? AND revertida = 0").get(p.id).s;
  const libre = p.monto_cents - aplicado;
  const u = unidadDe(db, cid, p.unidad_id);
  const doc = p.folio ? `recibo R-${p.folio}` : 'saldo a favor inicial';
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha: fechaContable(db, cid, hoy()), concepto: `Cancelación ${doc} · ${u.clave} · ${motivo}`, origen: 'cancelacion_pago', origen_id: p.id, reversa_de: p.poliza_id,
    lineas: [
      { cuenta: cuenta(db, cid, 'CXC'), unidad: u.id, debe: aplicado, concepto: `Cancelación ${doc}` },
      { cuenta: cuenta(db, cid, 'ANTICIPOS'), unidad: u.id, debe: libre, concepto: `Cancelación ${doc}` },
      { cuenta: cuentaDeCobro(db, cid, p), haber: p.monto_cents, concepto: `Cancelación ${doc}` },
    ],
  }, user);
  db.prepare('UPDATE aplicaciones SET revertida = 1 WHERE pago_id = ? AND revertida = 0').run(p.id);
  db.prepare("UPDATE pagos SET estado = 'cancelado', motivo = ?, cancel_poliza_id = ? WHERE id = ?").run(motivo, pid, p.id);
  if (p.poliza_id) db.prepare('UPDATE polizas SET reversada_por = ? WHERE id = ? AND reversada_por IS NULL').run(pid, p.poliza_id);
  db.prepare("UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE conciliado_tipo = 'pago' AND conciliado_id = ?").run(p.id);
  return { poliza_id: pid };
}

// ---------- Saldos iniciales (migración desde otro sistema) ----------
// Adeudo: cargo contra «Remanente de ejercicios anteriores» (no es ingreso del ejercicio).
// Saldo a favor: crédito de la unidad contra el mismo remanente; se aplica a cargos futuros.
// Uno por unidad: reimportar el archivo no duplica.
export function saldoInicial(db, cid, d, user) {
  const u = unidadDe(db, cid, d.unidad_id);
  if (!d.monto_cents) fail(400, 'El saldo es cero; no hay nada que registrar.');
  const concepto = d.concepto || `Saldo inicial al ${d.fecha}`;
  if (d.monto_cents > 0) {
    if (db.prepare('SELECT 1 FROM cargos WHERE dedupe_key = ?').get(`INI:${u.id}`)) return { omitido: true, motivo: 'La unidad ya tiene adeudo inicial registrado.' };
    const r = insertarCargos(db, cid, [{ unidad: u.id, tipo: 'otro', cuentaClave: 'REMANENTE', concepto, periodo: periodoDe(d.fecha), vencimiento: d.fecha, monto: d.monto_cents, reserva: 0, dedupe: `INI:${u.id}` }],
      { concepto: `Saldo inicial · ${u.clave}`, fecha: d.fecha, origen: 'saldo_inicial' }, user);
    return { tipo: 'adeudo', monto: d.monto_cents, poliza_id: r.poliza_id };
  }
  const key = `INI-${cid}-${u.id}`;
  if (db.prepare('SELECT 1 FROM pagos WHERE idem_key = ?').get(key)) return { omitido: true, motivo: 'La unidad ya tiene saldo a favor inicial registrado.' };
  const monto = -d.monto_cents;
  const r = db.prepare(`INSERT INTO pagos (condominio_id, unidad_id, fecha, monto_cents, metodo, estado, idem_key, notas, created_by, created_at)
    VALUES (?,?,?,?,'deposito','por_validar',?,?,?,?)`).run(cid, u.id, d.fecha, monto, key, concepto.slice(0, 300), user?.id ?? null, Date.now());
  const pagoId = Number(r.lastInsertRowid);
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha: d.fecha, concepto: `Saldo a favor inicial · ${u.clave}`, origen: 'saldo_inicial', origen_id: pagoId,
    lineas: [
      { cuenta: cuenta(db, cid, 'REMANENTE'), debe: monto, concepto },
      { cuenta: cuenta(db, cid, 'ANTICIPOS'), unidad: u.id, haber: monto, concepto },
    ],
  }, user);
  db.prepare("UPDATE pagos SET estado = 'aplicado', poliza_id = ?, validado_por = ?, validado_at = ? WHERE id = ?").run(pid, user?.id ?? null, Date.now(), pagoId);
  aplicarSaldoFavor(db, cid, u.id, d.fecha, user);
  return { tipo: 'favor', monto, poliza_id: pid };
}

// ---------- Egresos (con segregación de funciones) ----------
function provisionarEgreso(db, cid, e, user) {
  const prov = e.proveedor_id ? db.prepare('SELECT nombre FROM proveedores WHERE id = ?').get(e.proveedor_id)?.nombre : null;
  const destino = e.fondo !== 'reserva' ? e.cuenta_id : e.fondo_id ? fondoDe(db, cid, e.fondo_id).cuenta_id : cuenta(db, cid, 'FONDO_RESERVA');
  const pid = crearPoliza(db, cid, {
    tipo: 'D', fecha: fechaContable(db, cid, e.fecha), concepto: `Provisión E-${e.folio} · ${e.concepto}${prov ? ' · ' + prov : ''}`, origen: 'egreso', origen_id: e.id,
    lineas: [
      { cuenta: destino, debe: e.total_cents, concepto: e.concepto },
      { cuenta: cuenta(db, cid, 'CXP'), haber: e.total_cents, concepto: prov || e.concepto },
    ],
  }, user);
  db.prepare("UPDATE egresos SET estado = 'aprobado', aprobado_por = ?, aprobado_at = ?, poliza_prov_id = ? WHERE id = ?").run(user?.id ?? null, Date.now(), pid, e.id);
}

export function crearEgreso(db, cid, d, user) {
  const prev = db.prepare('SELECT id, folio, estado FROM egresos WHERE idem_key = ?').get(d.idem_key);
  if (prev) return { ...prev, repetido: true };
  const c = condo(db, cid);
  const cta = db.prepare("SELECT id FROM cuentas WHERE id = ? AND condominio_id = ? AND tipo = 'egreso' AND activo = 1").get(d.cuenta_id, cid);
  if (!cta) fail(400, 'Seleccione una partida de gasto válida.');
  if (d.proveedor_id && !db.prepare('SELECT 1 FROM proveedores WHERE id = ? AND condominio_id = ?').get(d.proveedor_id, cid)) fail(400, 'Proveedor inválido.');
  const total = d.subtotal_cents + d.iva_cents - d.retenciones_cents;
  if (total <= 0) fail(400, 'El total del egreso debe ser mayor a cero.');
  if (d.cfdi_uuid && db.prepare("SELECT 1 FROM egresos WHERE condominio_id = ? AND cfdi_uuid = ? COLLATE NOCASE AND estado NOT IN ('cancelado','rechazado')").get(cid, d.cfdi_uuid))
    fail(409, 'Esta factura (UUID) ya fue registrada.', 'DUPLICADO');
  if (d.proveedor_id && d.factura_folio && db.prepare("SELECT 1 FROM egresos WHERE condominio_id = ? AND proveedor_id = ? AND factura_folio = ? AND estado NOT IN ('cancelado','rechazado')").get(cid, d.proveedor_id, d.factura_folio))
    fail(409, 'Este proveedor ya tiene registrada una factura con ese folio.', 'DUPLICADO');
  const folio = db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 f FROM egresos WHERE condominio_id = ?').get(cid).f;
  const fondoId = d.fondo_id ? fondoDe(db, cid, d.fondo_id).id : null; // un fondo específico siempre se paga como uso de fondo (requiere aprobación)
  const r = db.prepare(`INSERT INTO egresos (condominio_id, folio, proveedor_id, cuenta_id, fondo, fondo_id, fecha, concepto, subtotal_cents, iva_cents, retenciones_cents, total_cents,
    factura_folio, cfdi_uuid, estado, comprobante_id, idem_key, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    cid, folio, d.proveedor_id ?? null, d.cuenta_id, fondoId ? 'reserva' : d.fondo || 'operacion', fondoId, d.fecha, d.concepto, d.subtotal_cents, d.iva_cents, d.retenciones_cents, total,
    d.factura_folio ?? null, d.cfdi_uuid ?? null, 'por_aprobar', d.comprobante_id ?? null, d.idem_key, user.id, Date.now());
  const e = db.prepare('SELECT * FROM egresos WHERE id = ?').get(Number(r.lastInsertRowid));
  const requiere = total >= c.umbral_aprobacion_cents || e.fondo === 'reserva';
  if (!requiere) provisionarEgreso(db, cid, e, user);
  return { id: e.id, folio, estado: requiere ? 'por_aprobar' : 'aprobado', requiere_aprobacion: requiere };
}

export function aprobarEgreso(db, cid, id, aprobar, motivo, user) {
  const e = db.prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?').get(id, cid) || fail(404, 'Egreso no encontrado');
  if (e.estado !== 'por_aprobar') fail(409, 'El egreso no está pendiente de aprobación.');
  if (e.created_by === user.id) fail(403, 'Segregación de funciones: quien captura un egreso no puede aprobarlo.', 'SOD');
  if (!aprobar) { db.prepare("UPDATE egresos SET estado = 'rechazado', motivo = ?, aprobado_por = ?, aprobado_at = ? WHERE id = ?").run(motivo || 'Rechazado', user.id, Date.now(), e.id); return { estado: 'rechazado' }; }
  provisionarEgreso(db, cid, e, user);
  return { estado: 'aprobado' };
}

export function pagarEgreso(db, cid, id, d, user) {
  const e = db.prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?').get(id, cid) || fail(404, 'Egreso no encontrado');
  if (e.estado !== 'aprobado') fail(409, e.estado === 'por_aprobar' ? 'El egreso requiere aprobación antes de pagarse.' : 'El egreso no puede pagarse en su estado actual.');
  const ctaPago = d.metodo === 'efectivo' && !d.cuenta_banco_id ? cuenta(db, cid, 'CAJA') : cuentaDeCobro(db, cid, { cuenta_banco_id: d.cuenta_banco_id, metodo: d.metodo });
  const pid = crearPoliza(db, cid, {
    tipo: 'E', fecha: fechaContable(db, cid, d.fecha_pago), concepto: `Pago E-${e.folio} · ${e.concepto}${d.referencia ? ' · ref. ' + d.referencia : ''}`, origen: 'pago_egreso', origen_id: e.id,
    lineas: [
      { cuenta: cuenta(db, cid, 'CXP'), debe: e.total_cents, concepto: e.concepto },
      { cuenta: ctaPago, haber: e.total_cents, concepto: e.concepto },
    ],
  }, user);
  db.prepare("UPDATE egresos SET estado = 'pagado', metodo_pago = ?, cuenta_banco_id = ?, referencia_pago = ?, fecha_pago = ?, pagado_por = ?, poliza_pago_id = ? WHERE id = ?")
    .run(d.metodo, d.cuenta_banco_id ?? null, d.referencia ?? null, d.fecha_pago, user.id, pid, e.id);
  return { poliza_id: pid };
}

export function cancelarEgreso(db, cid, id, motivo, user) {
  const e = db.prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?').get(id, cid) || fail(404, 'Egreso no encontrado');
  if (['cancelado', 'rechazado'].includes(e.estado)) fail(409, 'El egreso ya está cancelado.');
  const fecha = fechaContable(db, cid, hoy());
  for (const pol of [e.poliza_pago_id, e.poliza_prov_id].filter(Boolean)) {
    const movs = db.prepare('SELECT * FROM movimientos WHERE poliza_id = ?').all(pol);
    const nid = crearPoliza(db, cid, {
      tipo: 'D', fecha, concepto: `Cancelación E-${e.folio} · ${motivo}`, origen: 'cancelacion_egreso', origen_id: e.id, reversa_de: pol,
      lineas: movs.map(m => ({ cuenta: m.cuenta_id, debe: m.haber_cents, haber: m.debe_cents, concepto: m.concepto })),
    }, user);
    db.prepare('UPDATE polizas SET reversada_por = ? WHERE id = ? AND reversada_por IS NULL').run(nid, pol);
  }
  db.prepare("UPDATE egresos SET estado = 'cancelado', motivo = ? WHERE id = ?").run(motivo, e.id);
  db.prepare("UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE conciliado_tipo = 'egreso' AND conciliado_id = ?").run(e.id);
  return {};
}

// ---------- Bancos y conciliación ----------
export function crearCuentaBanco(db, cid, d) {
  const n = db.prepare("SELECT COUNT(*) n FROM cuentas WHERE condominio_id = ? AND codigo LIKE '1102-%'").get(cid).n + 1;
  const codigo = `1102-${String(n).padStart(2, '0')}`;
  const r = db.prepare("INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza) VALUES (?,?,?,?,?)").run(cid, codigo, `Bancos · ${d.banco} ${d.nombre}`, 'activo', 'D');
  const b = db.prepare('INSERT INTO cuentas_banco (condominio_id, nombre, banco, numero_mask, clabe_mask, cuenta_id, fondo) VALUES (?,?,?,?,?,?,?)')
    .run(cid, d.nombre, d.banco, mask(d.numero), mask(d.clabe), Number(r.lastInsertRowid), d.fondo || 'operacion');
  return Number(b.lastInsertRowid);
}

export function importarMovimientosBanco(db, cid, bancoId, filas, user) {
  const b = db.prepare('SELECT * FROM cuentas_banco WHERE id = ? AND condominio_id = ?').get(bancoId, cid) || fail(404, 'Cuenta bancaria no encontrada');
  const lote = 'IMP-' + token(6);
  const vistos = new Map();
  const ins = db.prepare(`INSERT OR IGNORE INTO banco_movs (cuenta_banco_id, fecha, descripcion, referencia, cargo_cents, abono_cents, huella, importacion) VALUES (?,?,?,?,?,?,?,?)`);
  let nuevos = 0, repetidos = 0;
  for (const f of filas) {
    const base = [b.id, f.fecha, f.cargo_cents, f.abono_cents, (f.descripcion || '').trim().toUpperCase(), (f.referencia || '').trim()].join('|');
    const n = (vistos.get(base) || 0) + 1; vistos.set(base, n); // movimientos idénticos legítimos dentro del mismo archivo
    const r = ins.run(b.id, f.fecha, f.descripcion || null, f.referencia || null, f.cargo_cents, f.abono_cents, sha256(base + '|' + n), lote);
    r.changes ? nuevos++ : repetidos++;
  }
  return { lote, nuevos, repetidos, conciliados: autoConciliar(db, cid, b.id, user) };
}

export function autoConciliar(db, cid, bancoId, user) {
  const movs = db.prepare('SELECT * FROM banco_movs WHERE cuenta_banco_id = ? AND conciliado_tipo IS NULL ORDER BY fecha').all(bancoId);
  const usado = db.prepare('SELECT 1 FROM banco_movs WHERE conciliado_tipo = ? AND conciliado_id = ?');
  const marcar = db.prepare('UPDATE banco_movs SET conciliado_tipo = ?, conciliado_id = ?, conciliado_por = ?, conciliado_at = ? WHERE id = ?');
  let n = 0;
  for (const m of movs) {
    let hit = null;
    if (m.abono_cents) {
      const cands = db.prepare(`SELECT p.id, p.referencia, u.referencia AS uref FROM pagos p JOIN unidades u ON u.id = p.unidad_id
        WHERE p.condominio_id = ? AND p.cuenta_banco_id = ? AND p.estado = 'aplicado' AND p.monto_cents = ? AND ABS(julianday(p.fecha) - julianday(?)) <= 4`).all(cid, bancoId, m.abono_cents, m.fecha)
        .filter(c => !usado.get('pago', c.id));
      const texto = `${m.descripcion || ''} ${m.referencia || ''}`.toUpperCase();
      hit = cands.find(c => (c.referencia && texto.includes(c.referencia.toUpperCase())) || texto.includes(c.uref)) || (cands.length === 1 ? cands[0] : null);
      if (hit) { marcar.run('pago', hit.id, user?.id ?? null, Date.now(), m.id); n++; }
    } else {
      const cands = db.prepare(`SELECT id FROM egresos WHERE condominio_id = ? AND cuenta_banco_id = ? AND estado = 'pagado' AND total_cents = ? AND ABS(julianday(fecha_pago) - julianday(?)) <= 4`)
        .all(cid, bancoId, m.cargo_cents, m.fecha).filter(c => !usado.get('egreso', c.id));
      if (cands.length === 1) { marcar.run('egreso', cands[0].id, user?.id ?? null, Date.now(), m.id); n++; }
    }
  }
  return n;
}

export function conciliarManual(db, cid, movId, tipo, id, user) {
  const m = db.prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE bm.id = ? AND b.condominio_id = ?').get(movId, cid) || fail(404, 'Movimiento no encontrado');
  if (tipo === null) { db.prepare('UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE id = ?').run(m.id); return; }
  if (m.conciliado_tipo) fail(409, 'El movimiento ya está conciliado.');
  if (db.prepare('SELECT 1 FROM banco_movs WHERE conciliado_tipo = ? AND conciliado_id = ?').get(tipo, id)) fail(409, 'Ese documento ya está conciliado con otro movimiento.');
  if (tipo === 'pago') {
    const p = db.prepare("SELECT monto_cents FROM pagos WHERE id = ? AND condominio_id = ? AND estado = 'aplicado'").get(id, cid) || fail(404, 'Pago no encontrado');
    if (p.monto_cents !== m.abono_cents) fail(400, 'El importe del pago no coincide con el depósito.');
  } else if (tipo === 'egreso') {
    const e = db.prepare("SELECT total_cents FROM egresos WHERE id = ? AND condominio_id = ? AND estado = 'pagado'").get(id, cid) || fail(404, 'Egreso no encontrado');
    if (e.total_cents !== m.cargo_cents) fail(400, 'El importe del egreso no coincide con el retiro.');
  } else if (tipo !== 'otro') fail(400, 'Tipo de conciliación inválido.');
  db.prepare('UPDATE banco_movs SET conciliado_tipo = ?, conciliado_id = ?, conciliado_por = ?, conciliado_at = ? WHERE id = ?').run(tipo, id ?? null, user.id, Date.now(), m.id);
}

// ---------- Convenios de pago ----------
export function crearConvenio(db, cid, d, user) {
  const u = unidadDe(db, cid, d.unidad_id);
  if (db.prepare("SELECT 1 FROM convenios WHERE unidad_id = ? AND estado = 'vigente'").get(u.id)) fail(409, 'La unidad ya tiene un convenio vigente.');
  if (d.condonar_recargos) for (const c of cargosAbiertos(db, u.id).filter(c => c.tipo === 'recargo')) bonificar(db, cid, c.id, c.saldo_cents, 'Condonación por convenio de pago', user);
  const deuda = cargosAbiertos(db, u.id).filter(c => c.vencimiento < d.fecha).reduce((a, c) => a + c.saldo_cents, 0);
  if (deuda <= 0) fail(400, 'La unidad no tiene saldo vencido para convenir.');
  const r = db.prepare('INSERT INTO convenios (condominio_id, unidad_id, fecha, monto_cents, parcialidades, estado, suspende_recargos, notas, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(cid, u.id, d.fecha, deuda, d.parcialidades, 'vigente', 1, d.notas ?? null, user.id, Date.now());
  const id = Number(r.lastInsertRowid);
  const partes = prorratear(deuda, Array(d.parcialidades).fill(1));
  const ins = db.prepare('INSERT INTO convenio_parcialidades (convenio_id, numero, vencimiento, monto_cents) VALUES (?,?,?,?)');
  partes.forEach((m, i) => ins.run(id, i + 1, `${addMonths(periodoDe(d.fecha), i + 1)}-${d.fecha.slice(8, 10) > '28' ? '28' : d.fecha.slice(8, 10)}`, m));
  return { id, monto_cents: deuda };
}

export function estadoConvenio(db, conv) {
  const restante = db.prepare(`SELECT COALESCE(SUM(${SALDO_CARGO}), 0) s FROM cargos c WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND c.vencimiento < ?`).get(conv.unidad_id, conv.fecha).s;
  const pagado = conv.monto_cents - Math.min(conv.monto_cents, restante);
  const exigible = db.prepare('SELECT COALESCE(SUM(monto_cents), 0) s FROM convenio_parcialidades WHERE convenio_id = ? AND vencimiento <= ?').get(conv.id, hoy()).s;
  return { pagado, restante: conv.monto_cents - pagado, exigible, al_corriente: pagado >= exigible };
}

// ---------- Presupuesto ----------
export function nuevaVersionPresupuesto(db, cid, ejercicio, user, copiarDe = null) {
  if (db.prepare("SELECT 1 FROM presupuestos WHERE condominio_id = ? AND ejercicio = ? AND estado = 'borrador'").get(cid, ejercicio)) fail(409, 'Ya existe un borrador para este ejercicio.');
  const version = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 v FROM presupuestos WHERE condominio_id = ? AND ejercicio = ?').get(cid, ejercicio).v;
  const r = db.prepare("INSERT INTO presupuestos (condominio_id, ejercicio, version, estado, created_by, created_at) VALUES (?,?,?,'borrador',?,?)").run(cid, ejercicio, version, user.id, Date.now());
  const id = Number(r.lastInsertRowid);
  const base = copiarDe ?? db.prepare("SELECT id FROM presupuestos WHERE condominio_id = ? AND estado = 'aprobado' ORDER BY ejercicio DESC LIMIT 1").get(cid)?.id;
  if (base) db.prepare('INSERT INTO presupuesto_lineas (presupuesto_id, cuenta_id, mes, monto_cents) SELECT ?, cuenta_id, mes, monto_cents FROM presupuesto_lineas WHERE presupuesto_id = ?').run(id, base);
  return id;
}

export function guardarLineasPresupuesto(db, cid, presId, lineas) {
  const p = db.prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?').get(presId, cid) || fail(404, 'Presupuesto no encontrado');
  if (p.estado !== 'borrador') fail(409, 'Solo se edita un presupuesto en borrador.');
  const valida = db.prepare("SELECT 1 FROM cuentas WHERE id = ? AND condominio_id = ? AND tipo IN ('egreso','ingreso')");
  const up = db.prepare('INSERT INTO presupuesto_lineas (presupuesto_id, cuenta_id, mes, monto_cents) VALUES (?,?,?,?) ON CONFLICT (presupuesto_id, cuenta_id, mes) DO UPDATE SET monto_cents = excluded.monto_cents');
  for (const l of lineas) {
    if (!valida.get(l.cuenta_id, cid) || !Number.isInteger(l.mes) || l.mes < 1 || l.mes > 12 || !Number.isSafeInteger(l.monto_cents) || l.monto_cents < 0) fail(400, 'Línea de presupuesto inválida.');
    up.run(p.id, l.cuenta_id, l.mes, l.monto_cents);
  }
}

export function aprobarPresupuesto(db, cid, presId, acta, user) {
  const p = db.prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?').get(presId, cid) || fail(404, 'Presupuesto no encontrado');
  if (p.estado !== 'borrador') fail(409, 'El presupuesto no está en borrador.');
  if (!db.prepare('SELECT 1 FROM presupuesto_lineas WHERE presupuesto_id = ? AND monto_cents > 0').get(p.id)) fail(400, 'El presupuesto está vacío.');
  db.prepare("UPDATE presupuestos SET estado = 'sustituido' WHERE condominio_id = ? AND ejercicio = ? AND estado = 'aprobado'").run(cid, p.ejercicio);
  db.prepare("UPDATE presupuestos SET estado = 'aprobado', acta = ?, aprobado_por = ?, aprobado_at = ? WHERE id = ?").run(acta, user.id, Date.now(), p.id);
}

// Cuota sugerida por unidad = gasto presupuestado mensual promedio × (1 + % reserva) × indiviso.
export function cuotaSugerida(db, cid, presId) {
  const c = condo(db, cid);
  const total = db.prepare("SELECT COALESCE(SUM(l.monto_cents), 0) s FROM presupuesto_lineas l JOIN cuentas k ON k.id = l.cuenta_id WHERE l.presupuesto_id = ? AND k.tipo = 'egreso'").get(presId).s;
  const mensualOper = Math.round(total / 12);
  const mensual = Math.round(mensualOper / (1 - c.pct_reserva_bp / 10000));
  const unidades = db.prepare('SELECT id, clave, indiviso_ppm, cuota_cents FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave').all(cid);
  const partes = unidades.length ? prorratear(mensual, unidades.map(u => u.indiviso_ppm)) : [];
  return { anual_egresos: total, mensual_requerido: mensual, unidades: unidades.map((u, i) => ({ ...u, sugerida_cents: Math.ceil(partes[i] / 100) * 100 })) };
}

// ---------- Cierres ----------
export function checklistCierre(db, cid, periodo) {
  const fin = `${periodo}-31`;
  return {
    pagos_por_validar: db.prepare("SELECT COUNT(*) n FROM pagos WHERE condominio_id = ? AND estado = 'por_validar' AND fecha <= ?").get(cid, fin).n,
    egresos_por_aprobar: db.prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar' AND fecha <= ?").get(cid, fin).n,
    movs_sin_conciliar: db.prepare('SELECT COUNT(*) n FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE b.condominio_id = ? AND bm.conciliado_tipo IS NULL AND bm.fecha <= ?').get(cid, fin).n,
    cuotas_emitidas: db.prepare("SELECT COUNT(*) n FROM cargos WHERE condominio_id = ? AND tipo = 'ordinaria' AND periodo = ?").get(cid, periodo).n,
    anteriores_abiertos: db.prepare("SELECT COUNT(*) n FROM periodos WHERE condominio_id = ? AND periodo < ? AND estado = 'abierto'").get(cid, periodo).n,
  };
}

export function cerrarPeriodo(db, cid, periodo, user) {
  const ck = checklistCierre(db, cid, periodo);
  if (ck.anteriores_abiertos) fail(409, 'Cierre primero los periodos anteriores.');
  if (ck.pagos_por_validar) fail(409, `Hay ${ck.pagos_por_validar} pagos reportados sin validar hasta este periodo.`);
  if (ck.egresos_por_aprobar) fail(409, `Hay ${ck.egresos_por_aprobar} egresos pendientes de aprobación hasta este periodo.`);
  if (periodo >= periodoDe(hoy())) fail(409, 'No se puede cerrar el periodo en curso.');
  db.prepare("INSERT INTO periodos (condominio_id, periodo, estado, cerrado_por, cerrado_at) VALUES (?, ?, 'cerrado', ?, ?) ON CONFLICT (condominio_id, periodo) DO UPDATE SET estado = 'cerrado', cerrado_por = excluded.cerrado_por, cerrado_at = excluded.cerrado_at")
    .run(cid, periodo, user?.id ?? null, Date.now());
  return ck;
}

export function reabrirPeriodo(db, cid, periodo) {
  const ultimo = db.prepare("SELECT MAX(periodo) p FROM periodos WHERE condominio_id = ? AND estado = 'cerrado'").get(cid).p;
  if (ultimo !== periodo) fail(409, 'Solo puede reabrirse el último periodo cerrado.');
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('permitir_reapertura', '1')").run();
  db.prepare("UPDATE periodos SET estado = 'abierto' WHERE condominio_id = ? AND periodo = ?").run(cid, periodo);
  db.prepare("DELETE FROM meta WHERE k = 'permitir_reapertura'").run();
}

// Cierre de ejercicio: traspasa el resultado del año a «Remanente de ejercicios anteriores».
export function cerrarEjercicio(db, cid, anio, user) {
  if (db.prepare("SELECT 1 FROM polizas WHERE condominio_id = ? AND origen = 'cierre_ejercicio' AND periodo = ? AND reversada_por IS NULL").get(cid, `${anio}-12`)) fail(409, 'El ejercicio ya fue cerrado.');
  const saldos = db.prepare(`SELECT k.id, k.tipo, SUM(m.debe_cents) - SUM(m.haber_cents) AS neto FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND k.tipo IN ('ingreso','egreso') GROUP BY k.id HAVING neto <> 0`).all(cid, `${anio}-01`, `${anio}-12`);
  if (!saldos.length) fail(400, 'No hay movimientos de resultados en el ejercicio.');
  const lineas = saldos.map(s => s.neto > 0 ? { cuenta: s.id, haber: s.neto } : { cuenta: s.id, debe: -s.neto });
  const neto = saldos.reduce((a, s) => a + s.neto, 0); // > 0 = déficit
  lineas.push(neto > 0 ? { cuenta: cuenta(db, cid, 'REMANENTE'), debe: neto, concepto: 'Déficit del ejercicio' } : { cuenta: cuenta(db, cid, 'REMANENTE'), haber: -neto, concepto: 'Remanente del ejercicio' });
  return crearPoliza(db, cid, { tipo: 'D', fecha: `${anio}-12-31`, concepto: `Cierre del ejercicio ${anio}`, origen: 'cierre_ejercicio', lineas }, user);
}

export { diffDays };
