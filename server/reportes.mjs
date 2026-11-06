// Reportes financieros. Todo se calcula desde el libro contable y el submayor de cargos,
// de modo que los estados de cuenta siempre cuadran con la contabilidad.
import { cuenta, condo, estadoConvenio } from './finanzas.mjs';
import { hoy, periodoDe, addMonths, diffDays, finDeMes } from './util.mjs';

const SALDO_CARGO = `c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0)`;

export function meses(desde, hasta) {
  const out = []; for (let p = desde; p <= hasta; p = addMonths(p, 1)) out.push(p); return out;
}

// Saldos por cuenta (debe/haber) en un rango de periodos.
function saldos(db, cid, desdeP, hastaP, { sinCierre = true } = {}) {
  return db.prepare(`SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, k.clave,
      COALESCE(SUM(m.debe_cents), 0) AS debe, COALESCE(SUM(m.haber_cents), 0) AS haber
    FROM cuentas k LEFT JOIN movimientos m ON m.cuenta_id = k.id
      AND m.poliza_id IN (SELECT id FROM polizas WHERE condominio_id = ? AND periodo BETWEEN ? AND ? ${sinCierre ? "AND origen <> 'cierre_ejercicio'" : ''})
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
      (SELECT MAX(fecha) FROM pagos WHERE unidad_id = u.id AND estado = 'aplicado') AS ultimo_pago
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
export function estadoCuenta(db, cid, uid, desde, hasta) {
  const cxc = cuenta(db, cid, 'CXC'), ant = cuenta(db, cid, 'ANTICIPOS');
  const rows = db.prepare(`SELECT p.id, p.fecha, p.tipo, p.folio, p.origen, p.origen_id,
      SUM(m.debe_cents - m.haber_cents) AS neto,
      (SELECT m2.concepto FROM movimientos m2 WHERE m2.poliza_id = p.id AND m2.unidad_id = ? AND m2.concepto IS NOT NULL ORDER BY m2.cuenta_id = ? DESC LIMIT 1) AS concepto
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id
    WHERE m.unidad_id = ? AND m.cuenta_id IN (?, ?) AND p.fecha <= ?
    GROUP BY p.id ORDER BY p.fecha, p.id`).all(uid, cxc, uid, cxc, ant, hasta);
  let inicial = 0, saldo = 0; const movs = [];
  for (const r of rows) {
    if (r.fecha < desde) { inicial += r.neto; continue; }
    if (r.neto === 0) continue; // aplicaciones internas de saldo a favor
    if (!movs.length) saldo = inicial;
    saldo += r.neto;
    const folio = r.origen === 'pago' ? db.prepare('SELECT folio, metodo, referencia FROM pagos WHERE id = ?').get(r.origen_id) : null;
    movs.push({ fecha: r.fecha, poliza: `${r.tipo}-${r.folio}`, origen: r.origen, concepto: r.concepto, cargo: r.neto > 0 ? r.neto : 0, abono: r.neto < 0 ? -r.neto : 0, saldo, recibo: folio?.folio ?? null });
  }
  const cargos = movs.reduce((a, m) => a + m.cargo, 0), abonos = movs.reduce((a, m) => a + m.abono, 0);
  const pendientes = db.prepare(`SELECT c.id, c.tipo, c.concepto, c.periodo, c.vencimiento, c.monto_cents, ${SALDO_CARGO} AS saldo_cents FROM cargos c
    WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND ${SALDO_CARGO} > 0 ORDER BY c.vencimiento`).all(uid);
  return { saldo_inicial: inicial, cargos, abonos, saldo_final: inicial + cargos - abonos, movimientos: movs, pendientes };
}

// ---------- Estados financieros ----------
export function estadoResultados(db, cid, desdeP, hastaP) {
  const ps = meses(desdeP, hastaP);
  const rows = db.prepare(`SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, p.periodo, SUM(m.debe_cents) d, SUM(m.haber_cents) h
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen <> 'cierre_ejercicio' AND k.tipo IN ('ingreso','egreso')
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
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen <> 'cierre_ejercicio' AND k.tipo = 'egreso' GROUP BY m.cuenta_id, mes`).all(cid, `${ejercicio}-01`, `${ejercicio}-12`);
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
    WHERE e.condominio_id = ? AND e.fondo = 'reserva' AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 7) BETWEEN ? AND ? ORDER BY e.fecha`).all(cid, desdeP, hastaP);
  return { inicial: ini, aportaciones: r.a, aplicaciones: r.u, final: ini + r.a - r.u, usos };
}

export function cobranzaMensual(db, cid, desdeP, hastaP) {
  return meses(desdeP, hastaP).map(p => {
    const emitido = db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM cargos WHERE condominio_id = ? AND periodo = ? AND tipo IN ('ordinaria','extraordinaria') AND cancelado_at IS NULL").get(cid, p).s;
    const cobradoDelMes = db.prepare(`SELECT COALESCE(SUM(a.monto_cents), 0) s FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id
      WHERE c.condominio_id = ? AND c.periodo = ? AND c.tipo IN ('ordinaria','extraordinaria') AND c.cancelado_at IS NULL AND a.revertida = 0`).get(cid, p).s;
    const recaudado = db.prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM pagos WHERE condominio_id = ? AND estado = 'aplicado' AND substr(fecha, 1, 7) = ?").get(cid, p).s;
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
