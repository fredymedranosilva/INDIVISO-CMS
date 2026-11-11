// Reportes financieros. Todo se calcula desde el libro contable y el submayor de cargos,
// de modo que los estados de cuenta siempre cuadran con la contabilidad.
import { cuenta, condo, estadoConvenio } from './finanzas.mjs';
import { hoy, periodoDe, addMonths, addDays, diffDays, finDeMes } from './util.mjs';

const SALDO_CARGO = `c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0)`;

export function meses(desde, hasta) {
  const out = []; for (let p = desde; p <= hasta; p = addMonths(p, 1)) out.push(p); return out;
}

// Saldos por cuenta (debe/haber) en un rango de periodos.
function saldos(db, cid, desdeP, hastaP, { sinCierre = true } = {}) {
  return db.prepare(`SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, k.clave,
      COALESCE(SUM(m.debe_cents), 0) AS debe, COALESCE(SUM(m.haber_cents), 0) AS haber
    FROM cuentas k LEFT JOIN movimientos m ON m.cuenta_id = k.id
      AND m.poliza_id IN (SELECT id FROM polizas WHERE condominio_id = ? AND periodo BETWEEN ? AND ? ${sinCierre ? "AND origen NOT IN ('cierre_ejercicio','reapertura_ejercicio')" : ''})
    WHERE k.condominio_id = ? GROUP BY k.id ORDER BY k.codigo`).all(cid, desdeP, hastaP, cid);
}
const saldoNat = r => r.naturaleza === 'D' ? r.debe - r.haber : r.haber - r.debe;

export function saldoBancos(db, cid, hastaP = '9999-12') {
  const ids = db.prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id FROM cuentas_banco b WHERE b.condominio_id = ? AND b.activo = 1').all(cid);
  const s = db.prepare(`SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?`);
  const bancos = ids.map(b => ({ ...b, saldo_cents: s.get(b.cuenta_id, hastaP).s }));
  const caja = s.get(cuenta(db, cid, 'CAJA'), hastaP).s;
  return { bancos, caja, total: bancos.reduce((a, b) => a + b.saldo_cents, 0) + caja };
}

export function saldoCuentaClave(db, cid, clave, hastaP = '9999-12') {
  const k = db.prepare('SELECT * FROM cuentas WHERE condominio_id = ? AND clave = ?').get(cid, clave);
  const r = db.prepare(`SELECT COALESCE(SUM(m.debe_cents), 0) debe, COALESCE(SUM(m.haber_cents), 0) haber FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?`).get(k.id, hastaP);
  return saldoNat({ ...k, ...r });
}

// ---------- Cartera y morosidad ----------
export function carteraUnidades(db, cid, corte = hoy()) {
  const unidades = db.prepare(`SELECT u.*, (SELECT GROUP_CONCAT(p.nombre, ', ') FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario') AS propietario,
      (SELECT p.email FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id ORDER BY up.rol = 'responsable' DESC, up.rol = 'propietario' DESC LIMIT 1) AS email,
      (SELECT p.telefono FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id ORDER BY up.rol = 'responsable' DESC, up.rol = 'propietario' DESC LIMIT 1) AS telefono,
      (SELECT MAX(fecha) FROM pagos WHERE unidad_id = u.id AND estado = 'aplicado' AND idem_key NOT LIKE 'INI-%') AS ultimo_pago
    FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave`).all(cid);
  const abiertos = db.prepare(`SELECT c.unidad_id, c.tipo, c.vencimiento, ${SALDO_CARGO} AS saldo FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.fecha <= ?`).all(cid, corte);
  const favor = db.prepare(`SELECT p.unidad_id, SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0)) AS s
    FROM pagos p WHERE p.condominio_id = ? AND p.estado = 'aplicado' GROUP BY p.unidad_id`).all(cid);
  const fav = new Map(favor.map(f => [f.unidad_id, f.s]));
  const conv = new Map(db.prepare("SELECT * FROM convenios WHERE condominio_id = ? AND estado = 'vigente'").all(cid).map(c => [c.unidad_id, c]));
  const map = new Map(unidades.map(u => [u.id, { ...u, por_vencer: 0, d30: 0, d60: 0, d90: 0, d90mas: 0, vencido: 0, adeudo: 0, recargos: 0, meses: 0, saldo_favor: fav.get(u.id) || 0, convenio: conv.get(u.id) || null, dias_max: 0 }]));
  for (const c of abiertos) {
    if (c.saldo <= 0) continue;
    const u = map.get(c.unidad_id); if (!u) continue;
    const dias = diffDays(corte, c.vencimiento);
    u.adeudo += c.saldo;
    if (c.tipo === 'recargo') u.recargos += c.saldo;
    if (dias <= 0) u.por_vencer += c.saldo;
    else {
      u.vencido += c.saldo; u.dias_max = Math.max(u.dias_max, dias);
      if (c.tipo === 'ordinaria') u.meses++;
      if (dias <= 30) u.d30 += c.saldo; else if (dias <= 60) u.d60 += c.saldo; else if (dias <= 90) u.d90 += c.saldo; else u.d90mas += c.saldo;
    }
  }
  return [...map.values()].map(u => ({ ...u, saldo_neto: u.adeudo - u.saldo_favor, convenio: u.convenio ? { id: u.convenio.id, ...estadoConvenio(db, u.convenio) } : null }));
}

export function resumenCartera(rows) {
  const t = { por_vencer: 0, d30: 0, d60: 0, d90: 0, d90mas: 0, vencido: 0, saldo_favor: 0, morosas: 0, unidades: rows.filter(r => r.activo).length };
  for (const r of rows) { for (const k of ['por_vencer', 'd30', 'd60', 'd90', 'd90mas', 'vencido', 'saldo_favor']) t[k] += r[k]; if (r.vencido > 0) t.morosas++; }
  t.pct_morosidad = t.unidades ? t.morosas / t.unidades : 0;
  return t;
}

// ---------- Estado de cuenta (desde el libro contable) ----------
// Una fila por cuota emitida (con su estatus actual) y una por pago, descuento o cancelación.
const TIPO_CARGO = { ordinaria: 'cuota', extraordinaria: 'extraordinaria', recargo: 'recargo', multa: 'multa', otro: 'otro' };
export function estadoCuenta(db, cid, uid, desde, hasta) {
  const cxc = cuenta(db, cid, 'CXC'), ant = cuenta(db, cid, 'ANTICIPOS');
  const lineas = db.prepare(`SELECT m.cuenta_id, m.debe_cents, m.haber_cents, m.concepto, p.id AS poliza_id, p.fecha, p.tipo AS ptipo, p.folio AS pfolio, p.origen, p.origen_id
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.unidad_id = ? AND m.cuenta_id IN (?, ?) AND p.fecha <= ? ORDER BY p.fecha, p.id, m.id`).all(uid, cxc, ant, hasta);
  const cargos = db.prepare(`SELECT c.id, c.tipo, c.concepto, c.monto_cents, c.poliza_id, c.cancelado_at, c.vencimiento, ${SALDO_CARGO} AS saldo,
    COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'pago'), 0) AS pagado FROM cargos c WHERE c.unidad_id = ?`).all(uid);
  const porPoliza = new Map();
  for (const c of cargos) { if (!porPoliza.has(c.poliza_id)) porPoliza.set(c.poliza_id, []); porPoliza.get(c.poliza_id).push(c); }
  const filas = [];
  let actual = null;
  for (const l of lineas) {
    if (l.cuenta_id === cxc && l.debe_cents > 0 && porPoliza.has(l.poliza_id)) {
      const lista = porPoliza.get(l.poliza_id);
      const cg = lista.find(c => !c._usado && c.monto_cents === l.debe_cents && c.concepto === l.concepto) || lista.find(c => !c._usado && c.monto_cents === l.debe_cents) || lista.find(c => !c._usado);
      if (cg) cg._usado = true;
      filas.push({ ...l, neto: l.debe_cents, cargo: cg || null });
      actual = null; continue;
    }
    if (!actual || actual.poliza_id !== l.poliza_id) { actual = { ...l, neto: 0, cargo: null }; filas.push(actual); }
    actual.neto += l.debe_cents - l.haber_cents;
  }
  const pagoQ = db.prepare('SELECT id, folio, metodo, referencia, estado, poliza_id FROM pagos WHERE id = ?');
  const aplQ = db.prepare("SELECT c.concepto FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.pago_id = ? AND a.tipo = 'pago' AND a.poliza_id = ? ORDER BY a.id");
  const bonQ = db.prepare('SELECT a.motivo, c.concepto FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.poliza_id = ? LIMIT 1');
  let inicial = 0, saldo = 0; const movs = [];
  for (const r of filas) {
    if (r.fecha < desde) { inicial += r.neto; continue; }
    if (r.neto === 0) continue; // aplicaciones internas de saldo a favor
    if (!movs.length) saldo = inicial;
    saldo += r.neto;
    const mv = { fecha: r.fecha, poliza: `${r.ptipo}-${r.pfolio}`, origen: r.origen, concepto: r.concepto, cargo: r.neto > 0 ? r.neto : 0, abono: r.neto < 0 ? -r.neto : 0, saldo, recibo: null, tipo: r.neto > 0 ? 'cargo' : 'abono', estatus: null };
    if (r.cargo) {
      const c = r.cargo;
      Object.assign(mv, { tipo: r.origen === 'saldo_inicial' ? 'saldo_inicial' : TIPO_CARGO[c.tipo], concepto: c.concepto, cargo_id: c.id, vencimiento: c.vencimiento, saldo_cargo: Math.max(0, c.saldo),
        estatus: c.cancelado_at ? 'cancelada' : c.saldo <= 0 ? (c.pagado ? 'pagada' : 'condonada') : c.saldo < c.monto_cents ? 'parcial' : 'pendiente' });
    } else if (r.origen === 'pago') {
      const p = pagoQ.get(r.origen_id);
      const aplicado = p ? aplQ.all(p.id, p.poliza_id).map(x => x.concepto) : [];
      Object.assign(mv, { tipo: 'pago', pago_id: p?.id ?? null, recibo: p?.folio ?? null, metodo: p?.metodo, referencia: p?.referencia, estatus: p?.estado === 'cancelado' ? 'cancelado' : 'aplicado',
        concepto: aplicado.length ? aplicado.join(' · ') : 'Pago a cuenta (queda como saldo a favor)' });
    } else if (r.origen === 'bonificacion') {
      const b = bonQ.get(r.poliza_id);
      Object.assign(mv, { tipo: 'descuento', concepto: b ? `${b.motivo === 'Descuento por pronto pago' ? 'Descuento por pronto pago' : `Bonificación · ${b.motivo}`}: ${b.concepto}` : r.concepto });
    } else if (r.origen === 'cancelacion_cargo') mv.tipo = 'cancelacion';
    else if (r.origen === 'cancelacion_pago') mv.tipo = 'cancelacion_pago';
    else if (r.origen === 'saldo_inicial') Object.assign(mv, { tipo: 'saldo_inicial', concepto: r.concepto || 'Saldo a favor inicial' });
    movs.push(mv);
  }
  const cargos_ = movs.reduce((a, m) => a + m.cargo, 0), abonos = movs.reduce((a, m) => a + m.abono, 0);
  const sum = (f, k) => movs.filter(f).reduce((a, m) => a + m[k], 0);
  const totales = {
    cuotas: sum(m => ['cuota', 'extraordinaria', 'otro', 'saldo_inicial'].includes(m.tipo), 'cargo'),
    penalidades: sum(m => m.tipo === 'recargo' || m.tipo === 'multa', 'cargo'),
    pagos: sum(m => m.tipo === 'pago' || (m.tipo === 'saldo_inicial' && m.abono), 'abono'),
    descuentos: sum(m => m.tipo === 'descuento' || m.tipo === 'cancelacion', 'abono'),
    otros_cargos: sum(m => m.tipo === 'cancelacion_pago' || m.tipo === 'cargo', 'cargo'),
  };
  const pendientes = db.prepare(`SELECT c.id, c.tipo, c.concepto, c.periodo, c.vencimiento, c.monto_cents, ${SALDO_CARGO} AS saldo_cents FROM cargos c
    WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND ${SALDO_CARGO} > 0 ORDER BY c.vencimiento`).all(uid);
  const favor = db.prepare(`SELECT COALESCE(SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0)), 0) s FROM pagos p WHERE p.unidad_id = ? AND p.estado = 'aplicado'`).get(uid).s;
  return { saldo_inicial: inicial, cargos: cargos_, abonos, saldo_final: inicial + cargos_ - abonos, movimientos: movs, pendientes, totales, saldo_favor: favor };
}

// ---------- Estados financieros ----------
export function estadoResultados(db, cid, desdeP, hastaP) {
  const ps = meses(desdeP, hastaP);
  const rows = db.prepare(`SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, p.periodo, SUM(m.debe_cents) d, SUM(m.haber_cents) h
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen NOT IN ('cierre_ejercicio','reapertura_ejercicio') AND k.tipo IN ('ingreso','egreso')
    GROUP BY k.id, p.periodo ORDER BY k.codigo`).all(cid, desdeP, hastaP);
  const cuentas = new Map();
  for (const r of rows) {
    if (!cuentas.has(r.id)) cuentas.set(r.id, { id: r.id, codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, meses: Object.fromEntries(ps.map(p => [p, 0])), total: 0 });
    const v = r.tipo === 'ingreso' ? r.h - r.d : r.d - r.h; // bonificaciones restan al ingreso
    cuentas.get(r.id).meses[r.periodo] += v; cuentas.get(r.id).total += v;
  }
  const list = [...cuentas.values()];
  const tot = tipo => Object.fromEntries(ps.map(p => [p, list.filter(c => c.tipo === tipo).reduce((a, c) => a + c.meses[p], 0)]));
  const ingresos = tot('ingreso'), egresos = tot('egreso');
  const resultado = Object.fromEntries(ps.map(p => [p, ingresos[p] - egresos[p]]));
  const sumv = o => Object.values(o).reduce((a, b) => a + b, 0);
  return { periodos: ps, ingresos: list.filter(c => c.tipo === 'ingreso'), egresos: list.filter(c => c.tipo === 'egreso'),
    total_ingresos: ingresos, total_egresos: egresos, resultado, totales: { ingresos: sumv(ingresos), egresos: sumv(egresos), resultado: sumv(resultado) } };
}

export function balanceGeneral(db, cid, hastaP) {
  const rows = saldos(db, cid, '0000-01', hastaP, { sinCierre: false }).map(r => ({ ...r, saldo: saldoNat(r) }));
  const grupo = t => rows.filter(r => r.tipo === t && r.saldo !== 0);
  // resultado = abonos − cargos de cuentas de resultados (las contra-cuentas como bonificaciones restan solas)
  const res = rows.filter(r => r.tipo === 'ingreso' || r.tipo === 'egreso').reduce((a, r) => a + r.haber - r.debe, 0);
  const activo = grupo('activo'), pasivo = grupo('pasivo'), patrimonio = grupo('patrimonio');
  const s = l => l.reduce((a, r) => a + r.saldo, 0);
  return { activo, pasivo, patrimonio, resultado_acumulado: res, total_activo: s(activo), total_pasivo: s(pasivo), total_patrimonio: s(patrimonio) + res,
    cuadra: s(activo) === s(pasivo) + s(patrimonio) + res };
}

export function balanza(db, cid, desdeP, hastaP) {
  const ini = new Map(saldos(db, cid, '0000-01', addMonths(desdeP, -1), { sinCierre: false }).map(r => [r.id, r]));
  const rows = saldos(db, cid, desdeP, hastaP, { sinCierre: false }).map(r => {
    const i = ini.get(r.id); const si = saldoNat(i);
    return { id: r.id, codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, naturaleza: r.naturaleza, inicial: si, debe: r.debe, haber: r.haber,
      final: si + (r.naturaleza === 'D' ? r.debe - r.haber : r.haber - r.debe) };
  }).filter(r => r.inicial || r.debe || r.haber);
  const tot = { debe: rows.reduce((a, r) => a + r.debe, 0), haber: rows.reduce((a, r) => a + r.haber, 0) };
  return { rows, totales: tot, cuadra: tot.debe === tot.haber };
}

export function libroMayor(db, cid, cuentaId, desdeP, hastaP) {
  const k = db.prepare('SELECT * FROM cuentas WHERE id = ? AND condominio_id = ?').get(cuentaId, cid);
  if (!k) return null;
  const ini = db.prepare(`SELECT COALESCE(SUM(m.debe_cents), 0) d, COALESCE(SUM(m.haber_cents), 0) h FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?`).get(k.id, desdeP);
  let saldo = k.naturaleza === 'D' ? ini.d - ini.h : ini.h - ini.d;
  const inicial = saldo;
  const movs = db.prepare(`SELECT p.id AS poliza_id, p.fecha, p.tipo, p.folio, p.concepto AS poliza_concepto, m.concepto, m.debe_cents, m.haber_cents, u.clave AS unidad
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id LEFT JOIN unidades u ON u.id = m.unidad_id
    WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ? ORDER BY p.fecha, p.id, m.id`).all(k.id, desdeP, hastaP).map(m => {
    saldo += k.naturaleza === 'D' ? m.debe_cents - m.haber_cents : m.haber_cents - m.debe_cents;
    return { ...m, saldo };
  });
  return { cuenta: k, inicial, final: saldo, movimientos: movs };
}

export function presupuestoVsReal(db, cid, ejercicio, presId = null) {
  const pres = presId ? db.prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?').get(presId, cid)
    : db.prepare("SELECT * FROM presupuestos WHERE condominio_id = ? AND ejercicio = ? ORDER BY estado = 'aprobado' DESC, version DESC LIMIT 1").get(cid, ejercicio);
  const lineas = pres ? db.prepare('SELECT cuenta_id, mes, monto_cents FROM presupuesto_lineas WHERE presupuesto_id = ?').all(pres.id) : [];
  const real = db.prepare(`SELECT m.cuenta_id, CAST(substr(p.periodo, 6, 2) AS INTEGER) AS mes, SUM(m.debe_cents - m.haber_cents) AS v
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen NOT IN ('cierre_ejercicio','reapertura_ejercicio') AND k.tipo = 'egreso' GROUP BY m.cuenta_id, mes`).all(cid, `${ejercicio}-01`, `${ejercicio}-12`);
  const cuentas = db.prepare("SELECT id, codigo, nombre FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo").all(cid);
  const mesActual = periodoDe(hoy()).startsWith(String(ejercicio)) ? +hoy().slice(5, 7) : (ejercicio < +hoy().slice(0, 4) ? 12 : 0);
  const rows = cuentas.map(k => {
    const p = Array(12).fill(0), r = Array(12).fill(0);
    for (const l of lineas) if (l.cuenta_id === k.id) p[l.mes - 1] = l.monto_cents;
    for (const x of real) if (x.cuenta_id === k.id) r[x.mes - 1] = x.v;
    const anual = p.reduce((a, b) => a + b, 0), ejercido = r.reduce((a, b) => a + b, 0);
    const alaFecha = p.slice(0, mesActual).reduce((a, b) => a + b, 0);
    return { ...k, presupuesto: p, real: r, anual, ejercido, a_la_fecha: alaFecha, variacion: alaFecha - ejercido, disponible: anual - ejercido };
  }).filter(r => r.anual || r.ejercido);
  const s = k => rows.reduce((a, r) => a + r[k], 0);
  return { presupuesto: pres || null, mes_actual: mesActual, rows, totales: { anual: s('anual'), ejercido: s('ejercido'), a_la_fecha: s('a_la_fecha'), disponible: s('disponible') } };
}

export function flujoEfectivo(db, cid, desdeP, hastaP) {
  const ctas = [...db.prepare('SELECT cuenta_id FROM cuentas_banco WHERE condominio_id = ?').all(cid).map(r => r.cuenta_id), cuenta(db, cid, 'CAJA')];
  const ph = ctas.map(() => '?').join(',');
  const ini = db.prepare(`SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE p.condominio_id = ? AND p.periodo < ? AND m.cuenta_id IN (${ph})`).get(cid, desdeP, ...ctas).s;
  const rows = db.prepare(`SELECT p.periodo, p.origen, SUM(m.debe_cents) e, SUM(m.haber_cents) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND m.cuenta_id IN (${ph}) GROUP BY p.periodo, p.origen`).all(cid, desdeP, hastaP, ...ctas);
  let saldo = ini;
  const ps = meses(desdeP, hastaP).map(p => {
    const r = rows.filter(x => x.periodo === p);
    const entradas = r.reduce((a, x) => a + x.e, 0), salidas = r.reduce((a, x) => a + x.s, 0);
    const inicial = saldo; saldo += entradas - salidas;
    return { periodo: p, inicial, entradas, salidas, final: saldo,
      cobranza: r.filter(x => x.origen === 'pago').reduce((a, x) => a + x.e, 0), pagos_proveedores: r.filter(x => x.origen === 'pago_egreso').reduce((a, x) => a + x.s, 0) };
  });
  return { inicial: ini, final: saldo, periodos: ps };
}

export function fondoReserva(db, cid, desdeP, hastaP) {
  const k = cuenta(db, cid, 'FONDO_RESERVA');
  const ini = db.prepare(`SELECT COALESCE(SUM(m.haber_cents - m.debe_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?`).get(k, desdeP).s;
  const r = db.prepare(`SELECT COALESCE(SUM(m.haber_cents), 0) a, COALESCE(SUM(m.debe_cents), 0) u FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?`).get(k, desdeP, hastaP);
  const usos = db.prepare(`SELECT e.folio, e.fecha, e.concepto, e.total_cents, pr.nombre AS proveedor FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id
    WHERE e.condominio_id = ? AND e.fondo = 'reserva' AND e.fondo_id IS NULL AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 7) BETWEEN ? AND ? ORDER BY e.fecha`).all(cid, desdeP, hastaP);
  return { inicial: ini, aportaciones: r.a, aplicaciones: r.u, final: ini + r.a - r.u, usos };
}

export function cobranzaMensual(db, cid, desdeP, hastaP) {
  return meses(desdeP, hastaP).map(p => {
    const emitido = db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM cargos WHERE condominio_id = ? AND periodo = ? AND tipo IN ('ordinaria','extraordinaria') AND cancelado_at IS NULL").get(cid, p).s;
    const cobradoDelMes = db.prepare(`SELECT COALESCE(SUM(a.monto_cents), 0) s FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id
      WHERE c.condominio_id = ? AND c.periodo = ? AND c.tipo IN ('ordinaria','extraordinaria') AND c.cancelado_at IS NULL AND a.revertida = 0`).get(cid, p).s;
    const recaudado = db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM pagos WHERE condominio_id = ? AND estado = 'aplicado' AND idem_key NOT LIKE 'INI-%' AND substr(fecha, 1, 7) = ?").get(cid, p).s;
    return { periodo: p, emitido, cobrado: cobradoDelMes, recaudado, indice: emitido ? cobradoDelMes / emitido : null };
  });
}

// ---------- Tablero ----------
export function tablero(db, cid, periodo) {
  const c = condo(db, cid);
  const cartera = carteraUnidades(db, cid);
  const rc = resumenCartera(cartera);
  const desde = addMonths(periodo, -11);
  const er = estadoResultados(db, cid, desde, periodo);
  const cob = cobranzaMensual(db, cid, desde, periodo);
  const pvr = presupuestoVsReal(db, cid, +periodo.slice(0, 4));
  const mes = +periodo.slice(5, 7);
  const presMes = pvr.rows.reduce((a, r) => a + r.presupuesto[mes - 1], 0);
  const cobMes = cob[cob.length - 1];
  return {
    condominio: { id: c.id, nombre: c.nombre },
    periodo,
    kpis: {
      emitido: cobMes.emitido, cobrado: cobMes.cobrado, recaudado: cobMes.recaudado, indice_cobranza: cobMes.indice,
      cartera_vencida: rc.vencido, unidades_morosas: rc.morosas, unidades: rc.unidades, pct_morosidad: rc.pct_morosidad,
      bancos: saldoBancos(db, cid), fondo_reserva: saldoCuentaClave(db, cid, 'FONDO_RESERVA'),
      egresos_mes: er.total_egresos[periodo] || 0, presupuesto_mes: presMes,
      ejercido_anual: pvr.totales.ejercido, presupuesto_anual: pvr.totales.anual, saldo_favor: rc.saldo_favor,
    },
    serie: er.periodos.map((p, i) => ({ periodo: p, ingresos: er.total_ingresos[p], egresos: er.total_egresos[p], recaudado: cob[i].recaudado, emitido: cob[i].emitido, indice: cob[i].indice })),
    antiguedad: { por_vencer: rc.por_vencer, d30: rc.d30, d60: rc.d60, d90: rc.d90, d90mas: rc.d90mas },
    top_morosos: cartera.filter(u => u.vencido > 0).sort((a, b) => b.vencido - a.vencido).slice(0, 6).map(u => ({ id: u.id, clave: u.clave, propietario: u.propietario, vencido: u.vencido, meses: u.meses, dias: u.dias_max, convenio: !!u.convenio })),
    egresos_partida: er.egresos.map(e => ({ nombre: e.nombre, total: e.meses[periodo] || 0 })).filter(e => e.total > 0).sort((a, b) => b.total - a.total),
    pendientes: {
      pagos_por_validar: db.prepare("SELECT COUNT(*) n FROM pagos WHERE condominio_id = ? AND estado = 'por_validar'").get(cid).n,
      egresos_por_aprobar: db.prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar'").get(cid).n,
      egresos_por_pagar: db.prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'aprobado'").get(cid).n,
      movs_sin_conciliar: db.prepare('SELECT COUNT(*) n FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE b.condominio_id = ? AND bm.conciliado_tipo IS NULL').get(cid).n,
      cuotas_mes_emitidas: !!db.prepare("SELECT 1 FROM cargos WHERE condominio_id = ? AND tipo = 'ordinaria' AND periodo = ? LIMIT 1").get(cid, periodo),
      periodo_anterior_abierto: !!db.prepare("SELECT 1 FROM periodos WHERE condominio_id = ? AND periodo < ? AND estado = 'abierto' LIMIT 1").get(cid, periodo),
    },
  };
}

// ---------- Informe anual (liquidación del ejercicio) ----------
export function informeAnual(db, cid, anio) {
  const c = condo(db, cid);
  const d = `${anio}-01`, h = `${anio}-12`;
  const corte = finDeMes(h) < hoy() ? finDeMes(h) : hoy();
  const cartera = carteraUnidades(db, cid, corte);
  const cob = cobranzaMensual(db, cid, d, h);
  const emit = cob.reduce((a, x) => a + x.emitido, 0), cobr = cob.reduce((a, x) => a + x.cobrado, 0);
  return {
    condominio: c, ejercicio: anio, corte,
    resultados: estadoResultados(db, cid, d, h),
    presupuesto: presupuestoVsReal(db, cid, anio),
    flujo: flujoEfectivo(db, cid, d, h),
    fondo_reserva: fondoReserva(db, cid, d, h),
    balance: balanceGeneral(db, cid, h),
    cobranza: { meses: cob, emitido: emit, cobrado: cobr, indice: emit ? cobr / emit : null },
    cartera: { resumen: resumenCartera(cartera), morosos: cartera.filter(u => u.vencido > 0).sort((a, b) => b.vencido - a.vencido).map(u => ({ clave: u.clave, propietario: u.propietario, vencido: u.vencido, meses: u.meses, convenio: !!u.convenio })) },
    cerrado: !!db.prepare("SELECT 1 FROM polizas WHERE condominio_id = ? AND origen = 'cierre_ejercicio' AND periodo = ? AND reversada_por IS NULL").get(cid, h),
  };
}

// ---------- Integridad global ----------
export function verificarIntegridad(db, cid) {
  const descuadradas = db.prepare(`SELECT p.id, p.tipo, p.folio FROM polizas p JOIN movimientos m ON m.poliza_id = p.id WHERE p.condominio_id = ?
    GROUP BY p.id HAVING SUM(m.debe_cents) <> SUM(m.haber_cents) OR SUM(m.debe_cents) <> p.total_cents`).all(cid);
  const cxc = cuenta(db, cid, 'CXC'), ant = cuenta(db, cid, 'ANTICIPOS');
  const libroCxc = db.prepare('SELECT COALESCE(SUM(debe_cents - haber_cents), 0) s FROM movimientos WHERE cuenta_id = ?').get(cxc).s;
  const subCxc = db.prepare(`SELECT COALESCE(SUM(${SALDO_CARGO}), 0) s FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL`).get(cid).s;
  const libroAnt = db.prepare('SELECT COALESCE(SUM(haber_cents - debe_cents), 0) s FROM movimientos WHERE cuenta_id = ?').get(ant).s;
  const subAnt = db.prepare(`SELECT COALESCE(SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0)), 0) s FROM pagos p WHERE p.condominio_id = ? AND p.estado = 'aplicado'`).get(cid).s;
  const bal = balanceGeneral(db, cid, '9999-12');
  return {
    polizas_descuadradas: descuadradas, balance_cuadra: bal.cuadra,
    cxc: { libro: libroCxc, submayor: subCxc, cuadra: libroCxc === subCxc },
    anticipos: { libro: libroAnt, submayor: subAnt, cuadra: libroAnt === subAnt },
    ok: !descuadradas.length && bal.cuadra && libroCxc === subCxc && libroAnt === subAnt,
  };
}

// ---------- Fondos: reserva y fondos específicos (pintura, impermeabilización...) ----------
export function fondos(db, cid, desdeP, hastaP) {
  const res = cuenta(db, cid, 'FONDO_RESERVA');
  const lista = [{ id: null, nombre: 'Fondo de reserva', cuenta_id: res, meta_cents: null, descripcion: 'Aportación mensual de las cuotas ordinarias', sistema: true },
    ...db.prepare('SELECT id, nombre, cuenta_id, meta_cents, descripcion, activo FROM fondos WHERE condominio_id = ? ORDER BY nombre').all(cid)];
  const ini = db.prepare(`SELECT COALESCE(SUM(m.haber_cents - m.debe_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?`);
  const mov = db.prepare(`SELECT COALESCE(SUM(m.haber_cents), 0) a, COALESCE(SUM(m.debe_cents), 0) u FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?`);
  const usos = db.prepare(`SELECT e.folio, e.fecha, e.concepto, e.total_cents, e.estado, pr.nombre AS proveedor FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id
    WHERE e.condominio_id = ? AND e.fondo = 'reserva' AND e.fondo_id IS ? AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 7) BETWEEN ? AND ? ORDER BY e.fecha DESC`);
  const rows = lista.map(f => {
    const i = ini.get(f.cuenta_id, desdeP).s, m = mov.get(f.cuenta_id, desdeP, hastaP);
    const saldo = i + m.a - m.u;
    return { ...f, inicial: i, aportaciones: m.a, aplicaciones: m.u, saldo, avance: f.meta_cents ? saldo / f.meta_cents : null, usos: usos.all(cid, f.id, desdeP, hastaP) };
  });
  return { desde: desdeP, hasta: hastaP, fondos: rows, total: rows.reduce((a, f) => a + f.saldo, 0) };
}

// ---------- Cuentas por pagar: egresos aprobados sin pagar, por antigüedad ----------
export function cuentasPorPagar(db, cid, corte = hoy()) {
  const rows = db.prepare(`SELECT e.id, e.folio, e.fecha, e.concepto, e.total_cents, e.factura_folio, e.fondo, pr.id AS proveedor_id, pr.nombre AS proveedor, k.codigo AS partida_codigo, k.nombre AS partida
    FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id JOIN cuentas k ON k.id = e.cuenta_id
    WHERE e.condominio_id = ? AND e.estado = 'aprobado' ORDER BY e.fecha`).all(cid);
  const banda = d => d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'd90mas';
  const t = { d30: 0, d60: 0, d90: 0, d90mas: 0, total: 0 }, prov = new Map();
  for (const r of rows) {
    r.dias = Math.max(0, diffDays(corte, r.fecha)); r.banda = banda(r.dias);
    t[r.banda] += r.total_cents; t.total += r.total_cents;
    const k = r.proveedor_id || 0;
    if (!prov.has(k)) prov.set(k, { proveedor: r.proveedor || 'Sin proveedor', d30: 0, d60: 0, d90: 0, d90mas: 0, total: 0, documentos: 0 });
    const p = prov.get(k); p[r.banda] += r.total_cents; p.total += r.total_cents; p.documentos++;
  }
  const porAprobar = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents), 0) s FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar'").get(cid);
  return { corte, totales: t, por_aprobar: porAprobar, proveedores: [...prov.values()].sort((a, b) => b.total - a.total), documentos: rows };
}

// ---------- Liquidación anual: lo emitido y lo pagado de cada unidad, mes por mes ----------
export function liquidacionAnual(db, cid, anio) {
  const ps = meses(`${anio}-01`, `${anio}-12`);
  const unidades = db.prepare(`SELECT u.id, u.clave, u.torre, u.cuota_cents, u.activo, (SELECT GROUP_CONCAT(p.nombre, ', ') FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario') AS propietario
    FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave`).all(cid);
  const cargos = db.prepare(`SELECT c.unidad_id, c.periodo, SUM(c.monto_cents) emitido, SUM(COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'pago'), 0)) pagado,
      SUM(COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'bonificacion'), 0)) bonificado
    FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.periodo BETWEEN ? AND ? GROUP BY c.unidad_id, c.periodo`).all(cid, ps[0], ps[11]);
  const previo = db.prepare(`SELECT c.unidad_id, SUM(${SALDO_CARGO}) s FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.periodo < ? GROUP BY c.unidad_id`).all(cid, ps[0]);
  const prev = new Map(previo.map(r => [r.unidad_id, r.s]));
  const map = new Map(unidades.map(u => [u.id, { ...u, adeudo_previo: prev.get(u.id) || 0, meses: Object.fromEntries(ps.map(p => [p, null])), emitido: 0, pagado: 0, bonificado: 0 }]));
  for (const c of cargos) {
    const u = map.get(c.unidad_id); if (!u) continue;
    const saldo = c.emitido - c.pagado - c.bonificado;
    u.meses[c.periodo] = { emitido: c.emitido, pagado: c.pagado, bonificado: c.bonificado, saldo, estado: saldo <= 0 ? 'pagado' : c.pagado + c.bonificado > 0 ? 'parcial' : 'pendiente' };
    u.emitido += c.emitido; u.pagado += c.pagado; u.bonificado += c.bonificado;
  }
  const rows = [...map.values()].map(u => ({ ...u, saldo: u.emitido - u.pagado - u.bonificado }));
  const tot = { emitido: 0, pagado: 0, bonificado: 0, saldo: 0, adeudo_previo: 0, meses: Object.fromEntries(ps.map(p => [p, { emitido: 0, pagado: 0 }])) };
  for (const u of rows) {
    for (const k of ['emitido', 'pagado', 'bonificado', 'saldo', 'adeudo_previo']) tot[k] += u[k];
    for (const p of ps) if (u.meses[p]) { tot.meses[p].emitido += u.meses[p].emitido; tot.meses[p].pagado += u.meses[p].pagado; }
  }
  return { ejercicio: anio, periodos: ps, unidades: rows, totales: tot };
}

// ---------- Control de descuentos y bonificaciones ----------
export function descuentos(db, cid, desde, hasta) {
  const rows = db.prepare(`SELECT a.id, a.monto_cents, a.motivo, a.revertida, a.created_at, p.fecha, c.concepto, c.periodo, c.tipo, u.id AS unidad_id, u.clave, us.nombre AS autor
    FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id JOIN unidades u ON u.id = c.unidad_id LEFT JOIN polizas p ON p.id = a.poliza_id LEFT JOIN usuarios us ON us.id = a.created_by
    WHERE a.condominio_id = ? AND a.tipo = 'bonificacion' AND p.fecha BETWEEN ? AND ? ORDER BY p.fecha DESC, a.id DESC LIMIT 2000`).all(cid, desde, hasta);
  const vig = rows.filter(r => !r.revertida);
  const porMotivo = new Map();
  for (const r of vig) { const k = /pronto pago/i.test(r.motivo || '') ? 'Pronto pago' : /convenio/i.test(r.motivo || '') ? 'Convenios' : 'Otras bonificaciones'; porMotivo.set(k, (porMotivo.get(k) || 0) + r.monto_cents); }
  return { desde, hasta, total: vig.reduce((a, r) => a + r.monto_cents, 0), por_tipo: [...porMotivo].map(([tipo, monto]) => ({ tipo, monto })), movimientos: rows };
}

// ---------- Ingresos: lo cobrado en el periodo, clasificado por lo que pagó ----------
// Pendientes de aplicar = cobrado que aún no cubre ninguna cuota (queda como saldo a favor).
const GRUPOS_ING = [['pendientes', 'Ingresos pendientes de aplicar'], ['ordinarios', 'Ingresos ordinarios'], ['extraordinarios', 'Ingresos extraordinarios'], ['otros', 'Otros ingresos']];
function agrupar(nombres) {
  const g = new Map(nombres.map(([k, n]) => [k, { clave: k, nombre: n, total: 0, clasif: new Map() }]));
  const add = (grupo, clasif, concepto, monto, extra = null) => {
    const G = g.get(grupo); G.total += monto;
    if (!G.clasif.has(clasif)) G.clasif.set(clasif, { nombre: clasif, total: 0, conceptos: new Map() });
    const C = G.clasif.get(clasif); C.total += monto;
    const k = extra ? `${concepto}\u0000${C.conceptos.size}` : concepto;
    const X = C.conceptos.get(k) || { concepto, total: 0, ...(extra || {}) };
    X.total += monto; C.conceptos.set(k, X);
  };
  const salida = () => [...g.values()].map(G => ({ clave: G.clave, nombre: G.nombre, total: G.total,
    clasificaciones: [...G.clasif.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map(C => ({ nombre: C.nombre, total: C.total, conceptos: [...C.conceptos.values()] })) }));
  return { add, salida };
}

const clasifDe = grupos => Object.fromEntries(grupos.flatMap(g => g.clasificaciones.map(c => [`${g.clave}|${c.nombre}`, c.total])));

export function ingresos(db, cid, desde, hasta) {
  const pagos = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(monto_cents), 0) s FROM pagos WHERE condominio_id = ? AND estado = 'aplicado' AND idem_key NOT LIKE 'INI-%' AND fecha BETWEEN ? AND ?`).get(cid, desde, hasta);
  const apl = db.prepare(`SELECT c.tipo, c.concepto, k.codigo, k.nombre, SUM(a.monto_cents) monto FROM aplicaciones a JOIN pagos p ON p.id = a.pago_id JOIN cargos c ON c.id = a.cargo_id JOIN cuentas k ON k.id = c.cuenta_ingreso_id
    WHERE p.condominio_id = ? AND p.estado = 'aplicado' AND p.idem_key NOT LIKE 'INI-%' AND p.fecha BETWEEN ? AND ? AND a.tipo = 'pago' AND a.revertida = 0
    GROUP BY c.tipo, c.concepto, k.id ORDER BY k.codigo, MIN(c.periodo), c.concepto`).all(cid, desde, hasta);
  const otros = db.prepare(`SELECT k.codigo, k.nombre, p.concepto, SUM(m.haber_cents - m.debe_cents) monto FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.origen = 'manual' AND p.fecha BETWEEN ? AND ? AND k.tipo = 'ingreso' AND p.reversada_por IS NULL GROUP BY k.id, p.concepto HAVING monto > 0`).all(cid, desde, hasta);
  const { add, salida } = agrupar(GRUPOS_ING);
  let aplicado = 0;
  for (const a of apl) { aplicado += a.monto; add(a.tipo === 'extraordinaria' ? 'extraordinarios' : 'ordinarios', `${a.codigo} · ${a.nombre}`, a.concepto, a.monto); }
  if (pagos.s - aplicado > 0) add('pendientes', 'Saldos a favor y anticipos', 'Pagos recibidos que aún no cubren ninguna cuota', pagos.s - aplicado);
  for (const o of otros) add('otros', `${o.codigo} · ${o.nombre}`, o.concepto, o.monto);
  const grupos = salida();
  return { desde, hasta, pagos: pagos.n, cobrado: pagos.s, total: grupos.reduce((a, g) => a + g.total, 0), grupos };
}

export function ingresosMensual(db, cid, anio) {
  const cob = new Map(cobranzaMensual(db, cid, `${anio}-01`, `${anio}-12`).map(x => [x.periodo, x]));
  return { anio, meses: meses(`${anio}-01`, `${anio}-12`).map(p => {
    const r = ingresos(db, cid, `${p}-01`, finDeMes(p));
    const g = Object.fromEntries(r.grupos.map(x => [x.clave, x.total]));
    const c = cob.get(p);
    return { periodo: p, ...g, total: r.total, pagos: r.pagos, emitido: c.emitido, cobrado_del_mes: c.cobrado, indice: c.indice, clasificaciones: clasifDe(r.grupos) };
  }) };
}

// ---------- Egresos del periodo por clasificación presupuestal ----------
export function egresosReporte(db, cid, desde, hasta) {
  const rows = db.prepare(`SELECT e.folio, e.fecha, e.concepto, e.total_cents, e.fondo, e.estado, k.codigo, k.nombre AS partida, pr.nombre AS proveedor, f.nombre AS fondo_nombre
    FROM egresos e JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN proveedores pr ON pr.id = e.proveedor_id LEFT JOIN fondos f ON f.id = e.fondo_id
    WHERE e.condominio_id = ? AND e.estado IN ('aprobado','pagado') AND e.fecha BETWEEN ? AND ? ORDER BY k.codigo, e.fecha, e.folio`).all(cid, desde, hasta);
  const { add, salida } = agrupar([['ordinarios', 'Egresos ordinarios'], ['extraordinarios', 'Egresos extraordinarios']]);
  for (const e of rows) add(e.fondo === 'reserva' ? 'extraordinarios' : 'ordinarios', `${e.codigo} · ${e.partida}`, e.concepto, e.total_cents,
    { folio: e.folio, fecha: e.fecha, proveedor: e.proveedor, estado: e.estado, fondo: e.fondo_nombre || (e.fondo === 'reserva' ? 'Fondo de reserva' : null) });
  const grupos = salida();
  const pagado = rows.filter(e => e.estado === 'pagado').reduce((a, e) => a + e.total_cents, 0);
  return { desde, hasta, documentos: rows.length, total: grupos.reduce((a, g) => a + g.total, 0), pagado, por_pagar: rows.reduce((a, e) => a + e.total_cents, 0) - pagado, grupos };
}

export function egresosMensual(db, cid, anio) {
  const pvr = presupuestoVsReal(db, cid, anio);
  const pres = Array.from({ length: 12 }, (_, i) => pvr.rows.reduce((a, r) => a + r.presupuesto[i], 0));
  return { anio, meses: meses(`${anio}-01`, `${anio}-12`).map((p, i) => {
    const r = egresosReporte(db, cid, `${p}-01`, finDeMes(p));
    const g = Object.fromEntries(r.grupos.map(x => [x.clave, x.total]));
    return { periodo: p, ...g, total: r.total, documentos: r.documentos, presupuesto: pres[i], clasificaciones: clasifDe(r.grupos) };
  }) };
}

// ---------- Saldos de bancos y caja: anterior, entradas, salidas y final, con su tendencia ----------
export function saldosBancarios(db, cid, desdeP, hastaP) {
  const cuentas = [...db.prepare(`SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id, k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id
    WHERE b.condominio_id = ? AND b.activo = 1 ORDER BY b.fondo, b.id`).all(cid), { id: null, nombre: 'Efectivo', banco: 'Caja', numero_mask: null, fondo: 'operacion', cuenta_id: cuenta(db, cid, 'CAJA'), codigo: '1101' }];
  const al = db.prepare('SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?');
  const mov = db.prepare('SELECT COALESCE(SUM(m.debe_cents), 0) e, COALESCE(SUM(m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?');
  const ps = desdeP === hastaP ? meses(addMonths(hastaP, -5), hastaP) : meses(desdeP, hastaP);
  const rows = cuentas.map(c => {
    const anterior = al.get(c.cuenta_id, addMonths(desdeP, -1)).s, m = mov.get(c.cuenta_id, desdeP, hastaP);
    return { ...c, anterior, ingresos: m.e, egresos: m.s, final: anterior + m.e - m.s, serie: ps.map(p => ({ periodo: p, saldo: al.get(c.cuenta_id, p).s })) };
  }).filter(c => c.id || c.anterior || c.ingresos || c.egresos);
  const t = k => rows.reduce((a, c) => a + c[k], 0);
  return { desde: desdeP, hasta: hastaP, cuentas: rows, totales: { anterior: t('anterior'), ingresos: t('ingresos'), egresos: t('egresos'), final: t('final') },
    serie: ps.map((p, i) => ({ periodo: p, saldo: rows.reduce((a, c) => a + c.serie[i].saldo, 0) })) };
}

// ---------- Conciliación bancaria al corte ----------
// Saldo del banco = saldo en libros el día anterior al primer movimiento importado + movimientos del estado de cuenta.
export function conciliacion(db, cid, desdeP, hastaP) {
  const corte = finDeMes(hastaP) < hoy() ? finDeMes(hastaP) : hoy(), desde = `${desdeP}-01`;
  const bancos = db.prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id FROM cuentas_banco b WHERE b.condominio_id = ? AND b.activo = 1 ORDER BY b.fondo, b.id').all(cid);
  const libros = db.prepare('SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.fecha <= ?');
  const cuentas = bancos.map(b => {
    const primero = db.prepare('SELECT MIN(fecha) f, MAX(fecha) u FROM banco_movs WHERE cuenta_banco_id = ?').get(b.id);
    const enLibros = libros.get(b.cuenta_id, corte).s;
    if (!primero.f || primero.f > corte) return { ...b, sin_estado: true, libros: enLibros };
    const base = libros.get(b.cuenta_id, addDays(primero.f, -1)).s;
    const bancoS = base + db.prepare('SELECT COALESCE(SUM(abono_cents - cargo_cents), 0) s FROM banco_movs WHERE cuenta_banco_id = ? AND fecha <= ?').get(b.id, corte).s;
    const delPeriodo = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(abono_cents), 0) dep, COALESCE(SUM(cargo_cents), 0) ret, SUM(conciliado_tipo IS NOT NULL) conc FROM banco_movs WHERE cuenta_banco_id = ? AND fecha BETWEEN ? AND ?').get(b.id, desde, corte);
    const noRegistrados = db.prepare('SELECT fecha, descripcion, referencia, abono_cents, cargo_cents FROM banco_movs WHERE cuenta_banco_id = ? AND fecha <= ? AND conciliado_tipo IS NULL ORDER BY fecha').all(b.id, corte);
    const depTransito = db.prepare(`SELECT p.fecha, 'R-' || p.folio || ' · ' || u.clave AS documento, p.referencia, p.monto_cents AS monto FROM pagos p JOIN unidades u ON u.id = p.unidad_id
      WHERE p.cuenta_banco_id = ? AND p.estado = 'aplicado' AND p.fecha BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'pago' AND x.conciliado_id = p.id) ORDER BY p.fecha`).all(b.id, primero.f, corte);
    const pagTransito = db.prepare(`SELECT e.fecha_pago AS fecha, 'E-' || e.folio || ' · ' || e.concepto AS documento, e.referencia_pago AS referencia, e.total_cents AS monto FROM egresos e
      WHERE e.cuenta_banco_id = ? AND e.estado = 'pagado' AND e.fecha_pago BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'egreso' AND x.conciliado_id = e.id) ORDER BY e.fecha_pago`).all(b.id, primero.f, corte);
    const s = (l, k) => l.reduce((a, x) => a + x[k], 0);
    const abonosNR = s(noRegistrados, 'abono_cents'), cargosNR = s(noRegistrados, 'cargo_cents'), dT = s(depTransito, 'monto'), pT = s(pagTransito, 'monto');
    const conciliado = bancoS - abonosNR + cargosNR + dT - pT;
    return { ...b, desde_estado: primero.f, ultimo_mov: primero.u, banco: b.banco, saldo_banco: bancoS, libros: enLibros,
      periodo: { movimientos: delPeriodo.n, depositos: delPeriodo.dep, retiros: delPeriodo.ret, conciliados: delPeriodo.conc || 0 },
      abonos_no_registrados: abonosNR, cargos_no_registrados: cargosNR, depositos_transito: dT, pagos_transito: pT, saldo_conciliado: conciliado, diferencia: enLibros - conciliado,
      no_registrados: noRegistrados, depositos_en_transito: depTransito, pagos_en_transito: pagTransito };
  });
  return { desde: desdeP, hasta: hastaP, corte, cuentas };
}
