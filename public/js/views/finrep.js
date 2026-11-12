// Reportes por periodo (mes y año) con gráficas y descarga en PDF: ingresos, egresos, cuentas por cobrar,
// saldos bancarios, conciliación y morosidad. Se usan en Reportes y en las pantallas de cada módulo.
import { capi, html, raw, mount, $, pesos, fecha, mesCorto, tabla, m, leerPeriodo, selectorPeriodo, filtrosAuto, dona, MESES_L, pct, hoy, toast, ICON, pill, S } from '../ui.js';

const pesosFmt = v => '$' + Math.round(v).toLocaleString('es-MX');
const sin00 = c => c ? '$' + Math.round(c / 100).toLocaleString('es-MX') : '$0';
const GRUPO_CAT = { pendientes: 8, ordinarios: 0, extraordinarios: 1, otros: 7 };
const ORDEN = ['pendientes', 'ordinarios', 'extraordinarios', 'otros'];

async function conPdf(fn, d) {
  toast('Generando PDF…');
  const [c, I] = await Promise.all([capi('/config'), import('../informes.js')]);
  await I[fn](d, c);
}
export const botonPdf = (accion = 'pdf', texto = 'Descargar PDF') => html`<button type="button" class="btn primary" data-action="${accion}">${raw(ICON.pdf)}<span>${texto}</span></button>`;
const filtros = (p, extra = '') => html`<form class="filters" data-f>${selectorPeriodo(p)}<span class="spacer"></span>${extra}</form>`;

// Tabla mes con mes: una fila por clasificación, una columna por mes (clic en el mes para verlo).
function tablaMeses(ms, ruta, p, { nombreDe, pie = 'Total', extra = null }) {
  const claves = [...new Set(ms.flatMap(x => Object.keys(x.clasificaciones || {})))]
    .sort((a, b) => ORDEN.indexOf(a.split('|')[0]) - ORDEN.indexOf(b.split('|')[0]) || a.localeCompare(b, 'es'));
  const total = ms.reduce((a, x) => a + x.total, 0);
  return html`<div class="table-wrap"><table class="tbl dense sabana-meses"><thead><tr><th>Clasificación</th>${ms.map((x, i) => html`<th class="r"><a class="link" href="${ruta}?anio=${p.anio}&mes=${i + 1}">${mesCorto(x.periodo)}</a></th>`)}<th class="r">Total</th></tr></thead>
    <tbody>${claves.length ? claves.map(k => { const vs = ms.map(x => x.clasificaciones?.[k] || 0); return html`<tr><td title="${nombreDe(k)}">${nombreDe(k)}</td>${vs.map((v, i) => html`<td class="r num ${v ? '' : 'zero'} ${p.mes === i + 1 ? 'sel' : ''}">${sin00(v)}</td>`)}<td class="r num"><b>${sin00(vs.reduce((a, b) => a + b, 0))}</b></td></tr>`; })
      : html`<tr class="empty"><td colspan="14">Sin movimientos en ${p.anio}.</td></tr>`}</tbody>
    <tfoot><tr><td>${pie}</td>${ms.map(x => html`<td class="r num">${sin00(x.total)}</td>`)}<td class="r num">${sin00(total)}</td></tr>${extra || ''}</tfoot></table></div>`;
}
const nombreClasif = k => { const [g, n] = k.split('|'); return g === 'pendientes' ? 'Pendientes de aplicar (saldo a favor)' : g === 'extraordinarios' ? `${n} · extraordinario` : n; };

// Detalle grupo → clasificación → concepto
function detalle(grupos, conceptoFn = x => x.concepto, totalTexto = 'Total') {
  const vis = grupos.filter(g => g.total);
  if (!vis.length) return html`<p class="empty-state">Sin movimientos en el periodo.</p>`;
  return html`<div class="table-wrap"><table class="tbl dense"><tbody>${vis.map(g => html`<tr class="grupo"><td>${g.nombre}</td><td class="r num">${pesos(g.total)}</td></tr>
    ${g.clasificaciones.map(c => html`<tr class="clasif"><td>${c.nombre}</td><td class="r num">${pesos(c.total)}</td></tr>${c.conceptos.map(x => html`<tr class="cuenta-ind"><td>${conceptoFn(x)}</td><td class="r num pos-t">${pesos(x.total)}</td></tr>`)}`)}`)}</tbody>
    <tfoot><tr><td>${totalTexto}</td><td class="r num">${pesos(vis.reduce((a, g) => a + g.total, 0))}</td></tr></tfoot></table></div>`;
}

// Excel con formato: título del reporte, condominio y periodo arriba; moneda, filtros y fila de totales.
async function excel(nombre, titulo, periodo, hojas) {
  const { escribirXlsx, guardarBlob } = await import('../xlsx.js');
  const condo = S.condos.find(x => x.id === S.cid)?.nombre || '';
  const enc = [titulo, `${condo} · ${periodo}`, `Generado el ${new Date().toLocaleString('es-MX')} · Indiviso CMS`];
  await guardarBlob(escribirXlsx(hojas.map(h => ({ total: true, ...h, titulo: [`${titulo} · ${h.nombre}`, ...enc.slice(1)] }))), nombre);
}
const P = c => (c || 0) / 100;
const hojaMeses = (titulo, ms, nombreDe) => {
  const claves = [...new Set(ms.flatMap(x => Object.keys(x.clasificaciones || {})))].sort();
  return { nombre: titulo, filas: [['Clasificación', ...ms.map(x => MESES_L[+x.periodo.slice(5) - 1]), 'Total'],
    ...claves.map(k => { const vs = ms.map(x => P(x.clasificaciones?.[k])); return [nombreDe(k), ...vs, vs.reduce((a, b) => a + b, 0)]; }),
    ['Total', ...ms.map(x => P(x.total)), P(ms.reduce((a, x) => a + x.total, 0))]], moneda: ms.map((_, i) => i + 1).concat(ms.length + 1) };
};
const hojaDetalle = (grupos, conceptoFn = x => x.concepto) => ({ nombre: 'Detalle', filas: [['Grupo', 'Clasificación', 'Concepto', 'Importe'],
  ...grupos.flatMap(g => g.clasificaciones.flatMap(c => c.conceptos.map(x => [g.nombre, c.nombre, conceptoFn(x), P(x.total)]))),
  ['Total', '', '', P(grupos.reduce((a, g) => a + g.total, 0))]], moneda: [3] });
const hojaResumen = (titulo, filas) => ({ nombre: titulo, filas: [['Concepto', 'Importe'], ...filas.map(([k, v]) => [k, P(v)])], moneda: [1], total: false });

// ---------- Ingresos ----------
export async function ingresosVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/reportes/ingresos?${p.qs}`);
  const g = Object.fromEntries(d.grupos.map(x => [x.clave, x.total]));
  const ms = d.mensual;
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Total de ingresos · ${p.texto}</p><p class="kpi-value md">${pesos(d.total)}</p><p class="sub">${d.pagos} pagos recibidos</p></div>
      <div class="kpi"><p class="label"><span class="sw cat0"></span>Ordinarios</p><p class="kpi-value md">${pesos(g.ordinarios || 0)}</p></div>
      <div class="kpi"><p class="label"><span class="sw cat1"></span>Extraordinarios</p><p class="kpi-value md">${pesos(g.extraordinarios || 0)}</p></div>
      <div class="kpi"><p class="label"><span class="sw cat8"></span>Pendientes de aplicar</p><p class="kpi-value md ${g.pendientes ? '' : 'zero'}">${pesos(g.pendientes || 0)}</p><p class="sub">Quedan como saldo a favor</p></div>
      ${g.otros ? html`<div class="kpi"><p class="label"><span class="sw cat7"></span>Otros ingresos</p><p class="kpi-value md">${pesos(g.otros)}</p></div>` : ''}</div></section>
    <div class="grid top top-gap">
      <section class="panel c5"><header><h2>Composición</h2><span class="meta">${p.texto}</span></header>${dona(d.grupos.map(x => ({ label: x.nombre.replace('Ingresos ', ''), valor: x.total, cat: GRUPO_CAT[x.clave] })), { sub: 'cobrado' })}</section>
      <section class="panel c7"><header><h2>Mes con mes · ${p.anio}</h2><span class="meta">Total cobrado en cada mes</span></header><div id="ch-ing" class="chart-box"></div></section>
    </div>
    <section class="panel top-gap"><header><h2>Por clasificación</h2><span class="meta">${p.texto}</span></header><div id="ch-clas"></div></section>
    <section class="panel flush top-gap"><header><h2>Ingresos mes con mes por clasificación · ${p.anio}</h2><span class="meta">Clic en un mes para ver su detalle</span></header>
      ${tablaMeses(ms, ruta, p, { nombreDe: nombreClasif, pie: 'Total cobrado', extra: html`<tr><td>Cuotas emitidas del mes</td>${ms.map(x => html`<td class="r num">${sin00(x.emitido)}</td>`)}<td class="r num">${sin00(ms.reduce((a, x) => a + x.emitido, 0))}</td></tr>
        <tr><td>Índice de cobranza del mes</td>${ms.map(x => html`<td class="r num">${x.indice == null ? '—' : pct(x.indice, 0)}</td>`)}<td></td></tr>` })}</section>
    <section class="panel flush top-gap"><header><h2>Detalle · ${p.texto}</h2><span class="meta">Qué se cobró, por clasificación y concepto</span></header>${detalle(d.grupos, undefined, 'Total de ingresos')}</section>`);
  window.Charts?.bars($('#ch-ing', el), { labels: ms.map(x => mesCorto(x.periodo)), values: ms.map(x => x.total / 100), highlight: p.mes ? p.mes - 1 : null, format: pesosFmt, tickFormat: window.Charts.fmt.compact, height: 210 });
  const clas = d.grupos.flatMap(x => x.clasificaciones.map(c => ({ label: x.clave === 'pendientes' ? 'Pendientes de aplicar' : c.nombre, value: c.total / 100 }))).sort((a, b) => b.value - a.value);
  if (clas.length) window.Charts?.barList($('#ch-clas', el), clas, { format: pesosFmt }); else mount($('#ch-clas', el), html`<p class="empty-chart">Sin cobros en el periodo.</p>`);
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({
    pdf: () => conPdf('pdfIngresos', d),
    excel: () => excel(`ingresos-${p.anio}${p.mes ? '-' + String(p.mes).padStart(2, '0') : ''}.xlsx`, 'Reporte de ingresos', p.texto, [
      hojaResumen('Resumen', [...d.grupos.map(g => [g.nombre, g.total]), ['Total de ingresos', d.total], ['Recibos cancelados en el periodo', -d.cancelados.monto], ['Periodo anterior', d.anterior?.total || 0]]),
      { nombre: 'Por forma de pago', filas: [['Forma de pago', 'Pagos', 'Importe'], ...d.por_metodo.map(x => [x.metodo, x.n, P(x.monto)]), ['Total', d.por_metodo.reduce((a, x) => a + x.n, 0), P(d.cobrado)]], moneda: [2] },
      { nombre: 'Por cuenta', filas: [['Cuenta', 'Pagos', 'Importe'], ...d.por_cuenta.map(x => [x.cuenta, x.n, P(x.monto)]), ['Total', d.por_cuenta.reduce((a, x) => a + x.n, 0), P(d.cobrado)]], moneda: [2] },
      { nombre: 'Por unidad', filas: [['Unidad', 'Propietario', 'Pagos', 'Importe'], ...d.por_unidad.map(x => [x.clave, x.propietario || '', x.n, P(x.monto)]), ['Total', '', d.por_unidad.reduce((a, x) => a + x.n, 0), P(d.cobrado)]], moneda: [3] },
      ...(d.recibos ? [{ nombre: 'Recibos', filas: [['Recibo', 'Fecha', 'Unidad', 'Propietario', 'Forma de pago', 'Cuenta', 'Referencia', 'Importe'], ...d.recibos.map(r => [`R-${r.folio}`, r.fecha, r.clave, r.propietario || '', r.metodo, r.cuenta, r.referencia || '', P(r.monto)]), ['Total', '', '', '', '', '', '', P(d.cobrado)]], moneda: [7] }] : []),
      hojaMeses(`Mes con mes ${p.anio}`, ms, nombreClasif), hojaDetalle(d.grupos)]),
  });
}

// ---------- Egresos ----------
const conceptoEgreso = x => `${x.concepto}${x.proveedor ? ` · ${x.proveedor}` : ''} · E-${x.folio} · ${fecha(x.fecha)}${x.estado === 'aprobado' ? ' · por pagar' : ''}`;
export async function egresosVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/reportes/egresos?${p.qs}`);
  const g = Object.fromEntries(d.grupos.map(x => [x.clave, x.total]));
  const ms = d.mensual;
  const presMes = p.mes ? ms[p.mes - 1].presupuesto : ms.slice(0, p.hastaP.slice(0, 4) == p.anio ? +p.hastaP.slice(5) : 12).reduce((a, x) => a + x.presupuesto, 0);
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Total de egresos · ${p.texto}</p><p class="kpi-value md">${pesos(d.total)}</p><p class="sub">${d.documentos} documentos</p></div>
      <div class="kpi"><p class="label"><span class="sw cat1"></span>Ordinarios</p><p class="kpi-value md">${pesos(g.ordinarios || 0)}</p></div>
      <div class="kpi"><p class="label"><span class="sw cat4"></span>Extraordinarios</p><p class="kpi-value md">${pesos(g.extraordinarios || 0)}</p><p class="sub">Fondo de reserva y fondos</p></div>
      <div class="kpi"><p class="label">Presupuesto del periodo</p><p class="kpi-value md">${pesos(presMes)}</p><p class="sub ${d.total > presMes && presMes ? 'neg-t' : ''}">${presMes ? `Ejercido ${pct(d.total / presMes, 0)}` : 'Sin presupuesto'}</p></div>
      <div class="kpi"><p class="label">Por pagar</p><p class="kpi-value md ${d.por_pagar ? '' : 'zero'}">${pesos(d.por_pagar)}</p></div></div></section>
    <div class="grid top top-gap">
      <section class="panel c5"><header><h2>Composición</h2><span class="meta">${p.texto}</span></header>${dona(d.grupos.map(x => ({ label: x.nombre.replace('Egresos ', ''), valor: x.total, cat: x.clave === 'ordinarios' ? 1 : 4 })), { sub: 'gastado' })}</section>
      <section class="panel c7"><header><h2>Mes con mes · ${p.anio}</h2><span class="meta">Gasto contra presupuesto</span></header><div id="ch-eg" class="chart-box"></div></section>
    </div>
    <section class="panel top-gap"><header><h2>Por clasificación presupuestal</h2><span class="meta">${p.texto}</span></header><div id="ch-clas"></div></section>
    <section class="panel flush top-gap"><header><h2>Egresos mes con mes por clasificación · ${p.anio}</h2><span class="meta">Clic en un mes para ver su detalle</span></header>
      ${tablaMeses(ms, ruta, p, { nombreDe: nombreClasif, pie: 'Total de egresos', extra: html`<tr><td>Presupuesto</td>${ms.map(x => html`<td class="r num">${sin00(x.presupuesto)}</td>`)}<td class="r num">${sin00(ms.reduce((a, x) => a + x.presupuesto, 0))}</td></tr>` })}</section>
    <section class="panel flush top-gap"><header><h2>Detalle · ${p.texto}</h2><span class="meta">Cada gasto aprobado, por clasificación</span></header>${detalle(d.grupos, conceptoEgreso, 'Total de egresos')}</section>`);
  window.Charts?.line($('#ch-eg', el), { labels: ms.map(x => mesCorto(x.periodo)), series: [{ name: 'Egresos', values: ms.map(x => x.total / 100) }, { name: 'Presupuesto', values: ms.map(x => x.presupuesto / 100), muted: true }], format: pesosFmt, tickFormat: window.Charts.fmt.compact, height: 210 });
  const clas = d.grupos.flatMap(x => x.clasificaciones.map(c => ({ label: c.nombre, value: c.total / 100 }))).sort((a, b) => b.value - a.value);
  if (clas.length) window.Charts?.barList($('#ch-clas', el), clas, { format: pesosFmt }); else mount($('#ch-clas', el), html`<p class="empty-chart">Sin egresos en el periodo.</p>`);
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({
    pdf: () => conPdf('pdfEgresos', d),
    excel: () => excel(`egresos-${p.anio}${p.mes ? '-' + String(p.mes).padStart(2, '0') : ''}.xlsx`, 'Reporte de egresos', p.texto, [
      hojaResumen('Resumen', [...d.grupos.map(g => [g.nombre, g.total]), ['Total de egresos', d.total], ['Pagado', d.pagado], ['Por pagar', d.por_pagar], ['Presupuesto del periodo', d.presupuesto?.total || 0], ['Periodo anterior', d.anterior?.total || 0]]),
      { nombre: 'Por partida', filas: [['Partida', 'Grupo', 'Ejercido', 'Presupuesto', 'Diferencia'], ...d.grupos.flatMap(g => g.clasificaciones.map(c => [c.nombre, g.nombre, P(c.total), g.clave === 'ordinarios' ? P(c.presupuesto) : '', g.clave === 'ordinarios' ? P((c.presupuesto || 0) - c.total) : ''])),
        ['Total', '', P(d.total), P(d.presupuesto?.total), P((d.presupuesto?.total || 0) - (d.presupuesto?.ejercido || 0))]], moneda: [2, 3, 4] },
      { nombre: 'Por proveedor', filas: [['Proveedor', 'Documentos', 'Importe'], ...d.por_proveedor.map(x => [x.proveedor, x.n, P(x.monto)]), ['Total', d.por_proveedor.reduce((a, x) => a + x.n, 0), P(d.total)]], moneda: [2] },
      { nombre: 'Documentos', filas: [['Folio', 'Fecha', 'Partida', 'Concepto', 'Proveedor', 'Factura', 'Estado', 'Importe'], ...d.grupos.flatMap(g => g.clasificaciones.flatMap(c => c.conceptos.map(x => [`E-${x.folio}`, x.fecha, c.nombre, x.concepto, x.proveedor || '', x.factura || '', x.estado, P(x.total)]))), ['Total', '', '', '', '', '', '', P(d.total)]], moneda: [7] },
      hojaMeses(`Mes con mes ${p.anio}`, ms, nombreClasif)]),
  });
}

// ---------- Cuentas por cobrar y morosidad (corte al fin del mes elegido) ----------
const BANDAS = [['por_vencer', 'Por vencer', 2], ['d30', '1 a 30 días', 4], ['d60', '31 a 60 días', 1], ['d90', '61 a 90 días', 5], ['d90mas', 'Más de 90 días', 9]];
export async function cxcVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/morosidad?corte=${p.hasta}`);
  const rows = d.unidades.filter(u => u.adeudo > 0).sort((a, b) => b.adeudo - a.adeudo);
  const r = d.resumen, total = rows.reduce((a, u) => a + u.adeudo, 0);
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Total por cobrar al ${fecha(d.corte)}</p><p class="kpi-value md">${pesos(total)}</p><p class="sub">${rows.length} de ${r.unidades} unidades</p></div>
      <div class="kpi"><p class="label">Vencido</p><p class="kpi-value md ${r.vencido ? 'neg-t' : 'zero'}">${pesos(r.vencido)}</p></div>
      <div class="kpi"><p class="label">Por vencer</p><p class="kpi-value md">${pesos(r.por_vencer)}</p></div>
      <div class="kpi"><p class="label">Saldos a favor</p><p class="kpi-value md ${r.saldo_favor ? 'pos-t' : 'zero'}">${pesos(r.saldo_favor)}</p></div></div></section>
    <div class="grid top top-gap">
      <section class="panel c5"><header><h2>Antigüedad</h2></header>${dona(BANDAS.map(([k, l, c]) => ({ label: l, valor: r[k], cat: c })), { sub: 'por cobrar' })}</section>
      <section class="panel c7"><header><h2>Unidades con mayor saldo</h2></header><div id="ch-top"></div></section></div>
    <section class="panel flush top-gap"><header><h2>Cartera por unidad</h2><span class="meta">Antigüedad desde el vencimiento</span></header>
      ${tabla([{ t: 'Unidad', k: u => html`<a class="link" href="#/c/${S.cid}/estados/?u=${u.id}">${u.clave}</a><span class="sub-t">${u.propietario || '—'}</span>` }, ...BANDAS.map(([k, l]) => ({ t: l.replace(' días', ''), num: true, k: u => m(u[k]), cls: 'hide-m' })), { t: 'Total', num: true, k: u => html`<b>${pesos(u.adeudo)}</b>` }],
        rows, { vacio: 'Ninguna unidad tiene saldo por cobrar.', pie: ['Total', ...BANDAS.map(([k]) => pesos(rows.reduce((a, u) => a + u[k], 0))), pesos(total)] })}</section>`);
  if (rows.length) window.Charts?.barList($('#ch-top', el), rows.slice(0, 10).map(u => ({ label: `${u.clave} · ${u.propietario || ''}`, value: u.adeudo / 100 })), { format: pesosFmt });
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({ pdf: () => conPdf('pdfCxc', d), excel: () => excel(`cuentas-por-cobrar-${d.corte}.xlsx`, 'Cuentas por cobrar', `Al ${fecha(d.corte)}`, [
    { nombre: 'Por unidad', filas: [['Unidad', 'Propietario', ...BANDAS.map(b => b[1]), 'Total por cobrar', 'Saldo a favor', 'Último pago'], ...rows.map(u => [u.clave, u.propietario || '', ...BANDAS.map(([k]) => P(u[k])), P(u.adeudo), P(u.saldo_favor), u.ultimo_pago || '']),
      ['Total', '', ...BANDAS.map(([k]) => P(rows.reduce((a, u) => a + u[k], 0))), P(total), P(rows.reduce((a, u) => a + u.saldo_favor, 0)), '']], moneda: [2, 3, 4, 5, 6, 7, 8] }]) });
}

export async function morosidadVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/morosidad?corte=${p.hasta}`);
  const r = d.resumen, rows = d.unidades.filter(u => u.activo && u.vencido > 0).sort((a, b) => b.vencido - a.vencido);
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Morosidad al ${fecha(d.corte)}</p><p class="kpi-value md ${r.morosas ? 'neg-t' : ''}">${pct(r.pct_morosidad)}</p><p class="sub">${r.morosas} de ${r.unidades} unidades</p></div>
      <div class="kpi"><p class="label">Cartera vencida</p><p class="kpi-value md">${pesos(r.vencido)}</p></div>
      <div class="kpi"><p class="label">Más de 90 días</p><p class="kpi-value md ${r.d90mas ? 'neg-t' : 'zero'}">${pesos(r.d90mas)}</p></div>
      <div class="kpi"><p class="label">Recargos por cobrar</p><p class="kpi-value md">${pesos(rows.reduce((a, u) => a + u.recargos, 0))}</p></div></div></section>
    <div class="grid top top-gap">
      <section class="panel c5"><header><h2>Antigüedad del vencido</h2></header>${dona(BANDAS.slice(1).map(([k, l, c]) => ({ label: l, valor: r[k], cat: c })), { sub: 'vencido' })}</section>
      <section class="panel c7"><header><h2>Mayor adeudo vencido</h2></header><div id="ch-mor"></div></section></div>
    <section class="panel flush top-gap"><header><h2>${rows.length} unidades morosas</h2></header>
      ${tabla([{ t: 'Unidad', k: u => html`<a class="link" href="#/c/${S.cid}/estados/?u=${u.id}">${u.clave}</a><span class="sub-t">${u.propietario || '—'}</span>` }, { t: 'Cuotas vencidas', num: true, k: u => u.meses }, { t: 'Días', num: true, k: u => u.dias_max, cls: 'hide-m' },
        { t: 'Recargos', num: true, k: u => m(u.recargos), cls: 'hide-m' }, { t: 'Vencido', num: true, k: u => html`<b>${pesos(u.vencido)}</b>` }, { t: 'Último pago', k: u => u.ultimo_pago ? fecha(u.ultimo_pago) : '—', cls: 'hide-m nowrap' },
        { t: '', k: u => u.convenio ? pill(u.convenio.al_corriente ? ['Convenio', 'pos'] : ['Convenio atrasado', 'neg']) : '' }], rows, { vacio: 'Sin unidades morosas a la fecha.' })}</section>`);
  if (rows.length) window.Charts?.barList($('#ch-mor', el), rows.slice(0, 10).map(u => ({ label: `${u.clave} · ${u.propietario || ''}`, value: u.vencido / 100 })), { format: pesosFmt });
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({ pdf: async () => conPdf('pdfMorosidad', await capi(`/morosidad?corte=${p.hasta}&detalle=1`)), excel: async () => {
    const dd = await capi(`/morosidad?corte=${p.hasta}&detalle=1`), mor = new Set(rows.map(u => u.id));
    await excel(`morosidad-${d.corte}.xlsx`, 'Reporte de morosidad', `Al ${fecha(d.corte)}`, [
      { nombre: 'Unidades morosas', filas: [['Unidad', 'Propietario', 'Teléfono', 'Correo', 'Cuotas vencidas', 'Días de atraso', 'Recargos', 'Vencido', 'Último pago', 'Convenio'], ...rows.map(u => [u.clave, u.propietario || '', u.telefono || '', u.email || '', u.meses, u.dias_max, P(u.recargos), P(u.vencido), u.ultimo_pago || '', u.convenio ? 'Sí' : '']),
        ['Total', '', '', '', rows.reduce((a, u) => a + u.meses, 0), '', P(rows.reduce((a, u) => a + u.recargos, 0)), P(r.vencido), '', '']], moneda: [6, 7] },
      { nombre: 'Cargos vencidos', filas: [['Unidad', 'Concepto', 'Vencimiento', 'Días', 'Importe', 'Saldo'], ...dd.cargos.filter(c => c.dias > 0 && mor.has(c.unidad_id)).map(c => [c.clave, c.concepto, c.vencimiento, c.dias, P(c.monto_cents), P(c.saldo_cents)]),
        ['Total', '', '', '', '', P(r.vencido)]], moneda: [4, 5] },
      { nombre: 'Tendencia', filas: [['Mes', 'Cartera vencida', 'Unidades morosas', '% morosidad'], ...dd.tendencia.map(t => [MESES_L[+t.periodo.slice(5) - 1] + ' ' + t.periodo.slice(0, 4), P(t.vencido), t.morosas, t.pct_morosidad])], moneda: [1], pct: [3], total: false }]);
  } });
}

// ---------- Saldos bancarios ----------
export async function bancosVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/reportes/bancos?${p.qs}`);
  const T = d.totales;
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Saldo anterior</p><p class="kpi-value md">${pesos(T.anterior)}</p></div>
      <div class="kpi"><p class="label">Ingresos · ${p.texto}</p><p class="kpi-value md pos-t">${pesos(T.ingresos)}</p></div>
      <div class="kpi"><p class="label">Egresos · ${p.texto}</p><p class="kpi-value md">${pesos(T.egresos)}</p></div>
      <div class="kpi"><p class="label">Saldo final</p><p class="kpi-value md">${pesos(T.final)}</p></div></div></section>
    <div class="grid top top-gap">${d.cuentas.map((c, i) => html`<section class="panel c6"><header><h2>${c.banco} · ${c.nombre}</h2><span class="meta">${c.codigo}${c.numero_mask ? ` · ${c.numero_mask}` : ''}${c.fondo === 'reserva' ? ' · reserva' : ''}</span></header>
      <ul class="rows"><li><span class="t">Saldo anterior</span><span class="v">${pesos(c.anterior)}</span></li><li><span class="t">Ingresos</span><span class="v pos-t">${pesos(c.ingresos)}</span></li><li><span class="t">Egresos</span><span class="v">${pesos(c.egresos)}</span></li><li><span class="t"><b>Saldo final</b></span><span class="v"><b>${pesos(c.final)}</b></span></li></ul>
      <div class="bank-chart" id="ch-b${i}"></div></section>`)}</div>`);
  d.cuentas.forEach((c, i) => window.Charts?.line($(`#ch-b${i}`, el), { labels: c.serie.map(s => mesCorto(s.periodo)), series: [{ name: 'Saldo', values: c.serie.map(s => s.saldo / 100) }], format: pesosFmt, tickFormat: window.Charts.fmt.compact, height: 140 }));
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({ pdf: () => conPdf('pdfBancos', d), excel: () => excel(`saldos-bancarios-${p.hastaP}.xlsx`, 'Saldos de bancos y caja', p.texto, [
    { nombre: 'Resumen', filas: [['Cuenta', 'Código', 'Saldo anterior', 'Ingresos', 'Egresos', 'Saldo final'], ...d.cuentas.map(c => [`${c.banco} · ${c.nombre}`, c.codigo, P(c.anterior), P(c.ingresos), P(c.egresos), P(c.final)]),
      ['Total', '', P(T.anterior), P(T.ingresos), P(T.egresos), P(T.final)]], moneda: [2, 3, 4, 5] },
    ...d.cuentas.map(c => ({ nombre: `${c.banco} ${c.nombre}`.slice(0, 31), filas: [['Fecha', 'Póliza', 'Concepto', 'Entrada', 'Salida', 'Saldo'], ['', '', 'Saldo anterior', '', '', P(c.anterior)], ...c.movimientos.map(m => [m.fecha, m.poliza, m.concepto, P(m.entrada), P(m.salida), P(m.saldo)]),
      ['Total', '', '', P(c.ingresos), P(c.egresos), P(c.final)]], moneda: [3, 4, 5] }))]) });
}

// ---------- Conciliación bancaria ----------
export async function conciliacionVista(el, ctx, q, ruta) {
  const p = leerPeriodo(q);
  const d = await capi(`/reportes/conciliacion?${p.qs}`);
  mount(el, html`${filtros(p, html`<button type="button" class="btn ghost" data-action="excel">Exportar a Excel</button>${botonPdf()}`)}
    ${d.cuentas.map(c => html`<section class="panel top-gap"><header><h2>${c.banco} · ${c.nombre}</h2><span class="meta">${c.sin_estado ? 'Sin estado de cuenta importado' : `Al ${fecha(d.corte)} · ${c.periodo.conciliados} de ${c.periodo.movimientos} movimientos del periodo conciliados`}</span></header>
      ${c.sin_estado ? html`<p class="note">Importe el estado de cuenta del banco en <a class="link" href="#/c/${S.cid}/bancos">Bancos y conciliación</a> para conciliar esta cuenta. Saldo en libros: <b>${pesos(c.libros)}</b>.</p>` : html`<div class="grid top">
        <div class="c6"><ul class="rows">
          <li><span class="t">Saldo según estado de cuenta</span><span class="v">${pesos(c.saldo_banco)}</span></li>
          <li><span class="t">(−) Depósitos del banco sin registrar</span><span class="v">${pesos(-c.abonos_no_registrados)}</span></li>
          <li><span class="t">(+) Retiros del banco sin registrar</span><span class="v">${pesos(c.cargos_no_registrados)}</span></li>
          <li><span class="t">(+) Depósitos en tránsito</span><span class="v">${pesos(c.depositos_transito)}</span></li>
          <li><span class="t">(−) Pagos en tránsito</span><span class="v">${pesos(-c.pagos_transito)}</span></li>
          ${c.otros_libros ? html`<li><span class="t">(±) Otros asientos en libros <span class="sub-t">traspasos, cancelaciones y ajustes</span></span><span class="v">${pesos(c.otros_libros)}</span></li>` : ''}
          <li><span class="t"><b>Saldo conciliado</b></span><span class="v"><b>${pesos(c.saldo_conciliado)}</b></span></li>
          <li><span class="t">Saldo en libros</span><span class="v">${pesos(c.libros)}</span></li>
          <li><span class="t"><b>Diferencia por aclarar</b></span><span class="v ${c.diferencia ? 'neg-t' : 'zero'}"><b>${pesos(c.diferencia)}</b></span></li></ul></div>
        <div class="c6">${dona([{ label: 'Conciliados', valor: c.periodo.conciliados, cat: 3 }, { label: 'Sin conciliar', valor: c.periodo.movimientos - c.periodo.conciliados, cat: 8 }], { formato: n => `${n} mov.`, centro: c.periodo.movimientos ? pct(c.periodo.conciliados / c.periodo.movimientos, 0) : '—', sub: 'conciliado' })}</div></div>
        ${c.no_registrados.length ? html`<h3 class="top-gap">Movimientos del banco sin identificar</h3>${tabla([{ t: 'Fecha', k: x => fecha(x.fecha), cls: 'nowrap' }, { t: 'Descripción', k: x => html`${x.descripcion || '—'}<span class="sub-t">${x.referencia || ''}</span>` }, { t: 'Importe', num: true, k: x => m(x.abono_cents || -x.cargo_cents) }], c.no_registrados.slice(0, 50))}` : ''}
        ${c.depositos_en_transito.length ? html`<h3 class="top-gap">Depósitos en tránsito</h3>${tabla([{ t: 'Fecha', k: x => fecha(x.fecha), cls: 'nowrap' }, { t: 'Documento', k: x => html`${x.documento}<span class="sub-t">${x.referencia || ''}</span>` }, { t: 'Importe', num: true, k: x => m(x.monto) }], c.depositos_en_transito.slice(0, 50))}` : ''}
        ${c.pagos_en_transito.length ? html`<h3 class="top-gap">Pagos en tránsito</h3>${tabla([{ t: 'Fecha', k: x => fecha(x.fecha), cls: 'nowrap' }, { t: 'Documento', k: x => x.documento }, { t: 'Importe', num: true, k: x => m(-x.monto) }], c.pagos_en_transito.slice(0, 50))}` : ''}`}</section>`)}`);
  filtrosAuto($('[data-f]', el), qs => { location.hash = `${ruta}?${qs}`; });
  ctx.acciones({ pdf: () => conPdf('pdfConciliacion', d), excel: () => excel(`conciliacion-${d.corte}.xlsx`, 'Conciliación bancaria', `Al ${fecha(d.corte)}`, d.cuentas.filter(c => !c.sin_estado).flatMap(c => [
    hojaResumen(`${c.banco} ${c.nombre}`.slice(0, 31), [['Saldo según estado de cuenta', c.saldo_banco], ['(−) Depósitos del banco sin registrar', -c.abonos_no_registrados], ['(+) Retiros del banco sin registrar', c.cargos_no_registrados],
      ['(+) Depósitos en tránsito', c.depositos_transito], ['(−) Pagos en tránsito', -c.pagos_transito], ['(±) Otros asientos en libros', c.otros_libros], ['Saldo conciliado', c.saldo_conciliado], ['Saldo en libros', c.libros], ['Diferencia por aclarar', c.diferencia]]),
    { nombre: `Partidas ${c.nombre}`.slice(0, 31), filas: [['Tipo', 'Fecha', 'Documento o descripción', 'Referencia', 'Importe'],
      ...c.no_registrados.map(x => ['Banco sin registrar', x.fecha, x.descripcion || '', x.referencia || '', P(x.abono_cents || -x.cargo_cents)]),
      ...c.depositos_en_transito.map(x => ['Depósito en tránsito', x.fecha, x.documento, x.referencia || '', P(x.monto)]),
      ...c.pagos_en_transito.map(x => ['Pago en tránsito', x.fecha, x.documento, x.referencia || '', P(-x.monto)]),
      ...c.otros_en_libros.map(x => ['Otro asiento en libros', x.fecha, x.documento, '', P(x.monto)])], moneda: [4], total: false }])) });
}

export const hoyStr = hoy;
