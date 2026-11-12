// Reportes financieros e informe anual (liquidación del ejercicio para la asamblea).
import { ingresosVista, egresosVista, cxcVista, bancosVista, conciliacionVista, morosidadVista } from './finrep.js';
import { capi, html, raw, mount, $, pesos, fecha, mesCorto, mesNombre, periodoActual, hoy, tabla, m, cargando, tabs, imprimir, pct, LOGO, barra, leerPeriodo, selectorPeriodo, filtrosAuto } from '../ui.js';

const rango = q => { const p = leerPeriodo(q, { mes: 0 }); return { desde: p.desdeP, hasta: p.hastaP, p }; };
const filtroMeses = (r, extra = '') => html`<form class="filters" data-f>${selectorPeriodo(r.p)}${raw(extra)}<span class="spacer"></span><button class="btn ghost" type="button" data-action="imprimir">Imprimir</button></form>`;

export async function render(el, ctx) {
  const [sub, qs] = (ctx.params[0] || 'ingresos').split('?');
  const q = new URLSearchParams(qs || '');
  mount(el, html`<div class="title-row"><div><h1>Reportes</h1><p class="sub">Reportes por mes y año con gráficas, listos para descargar en PDF; estados financieros calculados del libro contable.</p></div></div>
    ${tabs([['ingresos', 'Ingresos'], ['egresos', 'Egresos'], ['cxc', 'Cuentas por cobrar'], ['bancos', 'Saldos bancarios'], ['conciliacion', 'Conciliación'], ['morosidad', 'Morosidad'], ['resultados', 'Estado de resultados'], ['balance', 'Balance general'], ['flujo', 'Flujo de efectivo'], ['fondos', 'Fondos'], ['liquidacion', 'Liquidación anual'], ['anual', 'Informe anual']], sub, ctx.base)}<div id="rp-body"></div>`);
  const body = $('#rp-body', el);
  cargando(body);
  const nuevos = { ingresos: ingresosVista, egresos: egresosVista, cxc: cxcVista, bancos: bancosVista, conciliacion: conciliacionVista, morosidad: morosidadVista };
  if (nuevos[sub] || !sub) return (nuevos[sub] || ingresosVista)(body, ctx, q, `${ctx.base}/${sub || 'ingresos'}`);
  const anio = hoy().slice(0, 4);
  const def = { desde: `${anio}-01`, hasta: periodoActual() };
  const c = await capi('/config');
  const fns = { resultados, balance, flujo, reserva, fondos, liquidacion, anual };
  const doc = await (fns[sub] || resultados)(body, ctx, q, def, c);
  filtrosAuto($('[data-f]', body), p => { location.hash = `${ctx.base}/${sub}?${p}`; });
  ctx.acciones({ imprimir: () => imprimir(doc) });
}

const encabezado = (c, titulo, sub) => html`<header class="doc-head"><div><div class="brand">${raw(LOGO)}<div><b>${c.nombre}</b><small>${c.razon_social || ''}${c.rfc ? ` · RFC ${c.rfc}` : ''}</small></div></div></div><div class="right"><h2>${titulo}</h2><div class="org">${sub}</div></div></header>`;

function tablaResultados(er, { meses = true } = {}) {
  const ps = er.periodos;
  const cols = meses && ps.length <= 12;
  const fila = (k, cls = '') => html`<tr class="${cls}"><td>${k.nombre}</td>${cols ? ps.map(p => html`<td class="r num ${k.meses[p] ? '' : 'zero'}">${pesos(k.meses[p]).replace('.00', '')}</td>`) : ''}<td class="r num"><b>${pesos(k.total)}</b></td></tr>`;
  const tot = (l, o, total) => html`<tr class="total"><td>${l}</td>${cols ? ps.map(p => html`<td class="r num">${pesos(o[p]).replace('.00', '')}</td>`) : ''}<td class="r num">${pesos(total)}</td></tr>`;
  return html`<div class="table-wrap"><table class="tbl dense"><thead><tr><th>Concepto</th>${cols ? ps.map(p => html`<th class="r">${mesCorto(p)}</th>`) : ''}<th class="r">Total</th></tr></thead><tbody>
    <tr class="grupo"><td colspan="${ps.length + 2}">Ingresos</td></tr>${er.ingresos.map(k => fila(k, 'cuenta-ind'))}${tot('Total de ingresos', er.total_ingresos, er.totales.ingresos)}
    <tr class="grupo"><td colspan="${ps.length + 2}">Egresos</td></tr>${er.egresos.map(k => fila(k, 'cuenta-ind'))}${tot('Total de egresos', er.total_egresos, er.totales.egresos)}
    ${tot(er.totales.resultado >= 0 ? 'Remanente del periodo' : 'Déficit del periodo', er.resultado, er.totales.resultado)}
  </tbody></table></div>`;
}

async function resultados(el, ctx, q, def, c) {
  const r = rango(q, def);
  const er = await capi(`/reportes/resultados?desde=${r.desde}&hasta=${r.hasta}`);
  const doc = html`<article class="doc wide-doc">${encabezado(c, 'Estado de resultados', `De ${mesNombre(r.desde)} a ${mesNombre(r.hasta)}`)}${tablaResultados(er)}<footer class="doc-foot"><span>Base devengada. Las aportaciones al fondo de reserva no son ingreso: se registran en el patrimonio.</span><span>Indiviso CMS</span></footer></article>`;
  mount(el, html`${filtroMeses(r)}<section class="panel"><div class="kpis">
    <div class="kpi"><p class="label">Ingresos</p><p class="kpi-value md">${pesos(er.totales.ingresos)}</p></div><div class="kpi"><p class="label">Egresos</p><p class="kpi-value md">${pesos(er.totales.egresos)}</p></div>
    <div class="kpi"><p class="label">${er.totales.resultado >= 0 ? 'Remanente' : 'Déficit'}</p><p class="kpi-value md ${er.totales.resultado < 0 ? 'neg-t' : 'pos-t'}">${pesos(er.totales.resultado)}</p></div></div></section>
    <section class="panel top-gap">${tablaResultados(er)}</section>`);
  return doc;
}

function tablaBalance(b) {
  const grupo = (t, rows, total) => html`<tr class="grupo"><td colspan="2">${t}</td></tr>${rows.map(r => html`<tr class="cuenta-ind"><td>${r.codigo} · ${r.nombre}</td><td class="r num">${pesos(r.saldo)}</td></tr>`)}<tr class="total"><td>Total ${t.toLowerCase()}</td><td class="r num">${pesos(total)}</td></tr>`;
  return html`<div class="table-wrap"><table class="tbl dense"><tbody>
    ${grupo('Activo', b.activo, b.total_activo)}${grupo('Pasivo', b.pasivo, b.total_pasivo)}
    <tr class="grupo"><td colspan="2">Patrimonio</td></tr>${b.patrimonio.map(r => html`<tr class="cuenta-ind"><td>${r.codigo} · ${r.nombre}</td><td class="r num">${pesos(r.saldo)}</td></tr>`)}
    <tr class="cuenta-ind"><td>Resultado acumulado no traspasado</td><td class="r num">${pesos(b.resultado_acumulado)}</td></tr><tr class="total"><td>Total patrimonio</td><td class="r num">${pesos(b.total_patrimonio)}</td></tr>
    <tr class="total"><td>Pasivo más patrimonio</td><td class="r num">${pesos(b.total_pasivo + b.total_patrimonio)}</td></tr></tbody></table></div>`;
}

async function balance(el, ctx, q, def, c) {
  const hasta = q.get('hasta') || def.hasta;
  const b = await capi(`/reportes/balance?hasta=${hasta}`);
  const doc = html`<article class="doc">${encabezado(c, 'Balance general', `Al cierre de ${mesNombre(hasta)}`)}${tablaBalance(b)}<footer class="doc-foot"><span>${b.cuadra ? 'Activo = pasivo + patrimonio.' : 'ATENCIÓN: el balance no cuadra.'}</span><span>Indiviso CMS</span></footer></article>`;
  mount(el, html`<form class="filters" data-f><label class="field"><span>Al cierre de</span><input type="month" name="hasta" value="${hasta}"></label><button class="btn">Ver</button><span class="spacer"></span><button class="btn ghost" type="button" data-action="imprimir">Imprimir</button></form>
    <div class="grid top"><section class="panel c8">${tablaBalance(b)}</section><section class="panel c4"><header><h2>Comprobación</h2></header>
      <ul class="rows"><li><span class="t">Activo</span><span class="v">${pesos(b.total_activo)}</span></li><li><span class="t">Pasivo + patrimonio</span><span class="v">${pesos(b.total_pasivo + b.total_patrimonio)}</span></li><li><span class="t">Diferencia</span><span class="v ${b.cuadra ? 'zero' : 'neg-t'}">${pesos(b.total_activo - b.total_pasivo - b.total_patrimonio)}</span></li></ul>
      <p class="note ${b.cuadra ? 'pos' : 'neg'} top-gap">${b.cuadra ? 'El balance cuadra al centavo.' : 'El balance no cuadra: revise la integridad en Cierres.'}</p></section></div>`);
  return doc;
}

async function flujo(el, ctx, q, def, c) {
  const r = rango(q, def);
  const f = await capi(`/reportes/flujo?desde=${r.desde}&hasta=${r.hasta}`);
  const t = tabla([{ t: 'Mes', k: x => mesNombre(x.periodo) }, { t: 'Saldo inicial', num: true, k: x => m(x.inicial) }, { t: 'Cobranza', num: true, k: x => m(x.cobranza) }, { t: 'Entradas totales', num: true, k: x => m(x.entradas) },
    { t: 'Pagos a proveedores', num: true, k: x => m(x.pagos_proveedores) }, { t: 'Salidas totales', num: true, k: x => m(x.salidas) }, { t: 'Saldo final', num: true, k: x => html`<b>${pesos(x.final)}</b>` }], f.periodos);
  mount(el, html`${filtroMeses(r)}<section class="panel"><header><h2>Bancos y caja</h2><span class="meta">Inicial ${pesos(f.inicial)} · final ${pesos(f.final)}</span></header>${t}</section>`);
  return html`<article class="doc">${encabezado(c, 'Flujo de efectivo', `De ${mesNombre(r.desde)} a ${mesNombre(r.hasta)}`)}${t}</article>`;
}

async function reserva(el, ctx, q, def, c) {
  const r = rango(q, def);
  const f = await capi(`/reportes/fondo-reserva?desde=${r.desde}&hasta=${r.hasta}`);
  const cuerpo = html`<div class="kpis"><div class="kpi"><p class="label">Saldo inicial</p><p class="kpi-value md">${pesos(f.inicial)}</p></div><div class="kpi"><p class="label">Aportaciones</p><p class="kpi-value md">${pesos(f.aportaciones)}</p></div>
    <div class="kpi"><p class="label">Aplicaciones</p><p class="kpi-value md">${pesos(f.aplicaciones)}</p></div><div class="kpi"><p class="label">Saldo final</p><p class="kpi-value md">${pesos(f.final)}</p></div></div>
    <h3 class="top-gap">Usos del fondo aprobados</h3>${tabla([{ t: 'Folio', k: x => `E-${x.folio}` }, { t: 'Fecha', k: x => fecha(x.fecha) }, { t: 'Concepto', k: x => html`${x.concepto}<span class="sub-t">${x.proveedor || ''}</span>` }, { t: 'Importe', num: true, k: x => m(x.total_cents) }], f.usos, { vacio: 'Sin usos del fondo en el periodo.' })}`;
  mount(el, html`${filtroMeses(r)}<section class="panel">${cuerpo}</section>`);
  return html`<article class="doc">${encabezado(c, 'Fondo de reserva', `De ${mesNombre(r.desde)} a ${mesNombre(r.hasta)}`)}${cuerpo}</article>`;
}

async function fondos(el, ctx, q, def, c) {
  const r = rango(q, def);
  const f = await capi(`/reportes/fondos?desde=${r.desde}&hasta=${r.hasta}`);
  const cuerpo = html`${tabla([{ t: 'Fondo', k: x => html`<b>${x.nombre}</b><span class="sub-t">${x.descripcion || ''}</span>` }, { t: 'Saldo inicial', num: true, k: x => m(x.inicial) }, { t: 'Aportaciones', num: true, k: x => m(x.aportaciones) },
      { t: 'Aplicaciones', num: true, k: x => m(x.aplicaciones) }, { t: 'Saldo', num: true, k: x => html`<b>${pesos(x.saldo)}</b>` },
      { t: 'Meta', k: x => x.meta_cents ? html`<div class="hbar"><span>${pesos(x.meta_cents)}</span><span class="num">${pct(x.avance, 0)}</span>${barra(x.avance)}</div>` : html`<span class="faint">—</span>` }],
      f.fondos, { pie: ['Total', '', '', '', pesos(f.total), ''] })}
    ${f.fondos.filter(x => x.usos.length).map(x => html`<h3 class="top-gap">Usos de ${x.nombre}</h3>${tabla([{ t: 'Folio', k: e => `E-${e.folio}` }, { t: 'Fecha', k: e => fecha(e.fecha) }, { t: 'Concepto', k: e => html`${e.concepto}<span class="sub-t">${e.proveedor || ''}</span>` }, { t: 'Importe', num: true, k: e => m(e.total_cents) }], x.usos)}`)}`;
  mount(el, html`${filtroMeses(r)}<section class="panel">${cuerpo}<p class="small muted top-gap">Los fondos son patrimonio del condominio: no son ingreso del ejercicio. Cree fondos nuevos en Configuración.</p></section>`);
  return html`<article class="doc">${encabezado(c, 'Fondos', `De ${mesNombre(r.desde)} a ${mesNombre(r.hasta)}`)}${cuerpo}</article>`;
}

// Liquidación anual («sábana»): cada unidad, mes por mes, lo emitido contra lo pagado.
async function liquidacion(el, ctx, q, def, c) {
  const ej = +(q.get('ejercicio') || hoy().slice(0, 4));
  const l = await capi(`/reportes/liquidacion?ejercicio=${ej}`);
  const celda = x => !x ? html`<span class="faint">—</span>` : html`<span class="st ${x.estado}" title="Emitido ${pesos(x.emitido)} · pagado ${pesos(x.pagado)}${x.bonificado ? ` · bonificado ${pesos(x.bonificado)}` : ''}">${x.estado === 'pagado' ? '✓' : pesos(x.saldo).replace('.00', '')}</span>`;
  const t = html`<div class="table-wrap"><table class="tbl dense sabana"><thead><tr><th>Unidad</th><th class="r">Adeudo previo</th>${l.periodos.map(p => html`<th class="r">${mesCorto(p)}</th>`)}<th class="r">Emitido</th><th class="r">Pagado</th><th class="r">Saldo ${ej}</th></tr></thead>
    <tbody>${l.unidades.map(u => html`<tr><td><b>${u.clave}</b><span class="sub-t">${u.propietario || ''}</span></td><td class="r num ${u.adeudo_previo ? 'neg-t' : 'zero'}">${pesos(u.adeudo_previo)}</td>${l.periodos.map(p => html`<td class="mes">${celda(u.meses[p])}</td>`)}
      <td class="r num">${pesos(u.emitido)}</td><td class="r num">${pesos(u.pagado)}</td><td class="r num ${u.saldo > 0 ? 'neg-t' : ''}"><b>${pesos(u.saldo)}</b></td></tr>`)}</tbody>
    <tfoot><tr><td>Total</td><td class="r num">${pesos(l.totales.adeudo_previo)}</td>${l.periodos.map(p => html`<td class="r num small">${l.totales.meses[p].emitido ? pct(l.totales.meses[p].pagado / l.totales.meses[p].emitido, 0) : ''}</td>`)}
      <td class="r num">${pesos(l.totales.emitido)}</td><td class="r num">${pesos(l.totales.pagado)}</td><td class="r num">${pesos(l.totales.saldo)}</td></tr></tfoot></table></div>`;
  const anios = [ej, ej - 1, ej - 2].filter(x => x <= +hoy().slice(0, 4));
  mount(el, html`<form class="filters" data-f><label class="field"><span>Ejercicio</span><select name="ejercicio" data-auto>${anios.map(x => html`<option ${x === ej ? raw('selected') : ''}>${x}</option>`)}</select></label><button class="btn">Ver</button><span class="spacer"></span>
      <button class="btn ghost" type="button" data-action="excel">Exportar a Excel</button><button class="btn ghost" type="button" data-action="imprimir">Imprimir</button></form>
    <section class="panel"><div class="leyenda"><span><span class="st pagado">✓</span> pagado</span><span><span class="st parcial">$</span> pago parcial (saldo)</span><span><span class="st pendiente">$</span> sin pago (saldo)</span><span>La fila de totales muestra el % cobrado de cada mes.</span></div>
      <div class="top-gap">${t}</div></section>`);
  ctx.acciones({ excel: async () => {
    const { escribirXlsx, guardarBlob } = await import('../xlsx.js');
    const filas = [['Unidad', 'Propietario', 'Adeudo previo', ...l.periodos.map(p => `${mesCorto(p)} emitido`), ...l.periodos.map(p => `${mesCorto(p)} pagado`), 'Emitido', 'Pagado', 'Bonificado', 'Saldo'],
      ...l.unidades.map(u => [u.clave, u.propietario || '', u.adeudo_previo / 100, ...l.periodos.map(p => (u.meses[p]?.emitido || 0) / 100), ...l.periodos.map(p => (u.meses[p]?.pagado || 0) / 100), u.emitido / 100, u.pagado / 100, u.bonificado / 100, u.saldo / 100]),
      ['Total', '', l.totales.adeudo_previo / 100, ...l.periodos.map(p => l.totales.meses[p].emitido / 100), ...l.periodos.map(p => l.totales.meses[p].pagado / 100), l.totales.emitido / 100, l.totales.pagado / 100, l.totales.bonificado / 100, l.totales.saldo / 100]];
    await guardarBlob(escribirXlsx([{ nombre: `Liquidación ${ej}`, filas, total: true, titulo: [`Liquidación anual de cuotas ${ej}`, `${c?.nombre || ''} · Ejercicio ${ej}`, `Generado el ${new Date().toLocaleString('es-MX')} · Indiviso CMS`] }]), `liquidacion-anual-${ej}.xlsx`);
  } });
  return html`<article class="doc wide-doc">${encabezado(c, `Liquidación anual ${ej}`, 'Emitido contra pagado por unidad')}${t}</article>`;
}

async function anual(el, ctx, q, def, c) {
  const ej = +(q.get('ejercicio') || hoy().slice(0, 4));
  const a = await capi(`/reportes/anual?ejercicio=${ej}`);
  const er = a.resultados, pv = a.presupuesto, cob = a.cobranza, fr = a.fondo_reserva, fl = a.flujo, ca = a.cartera;
  const doc = html`<article class="doc">
    ${encabezado(c, `Informe anual ${ej}`, html`Liquidación del ejercicio · corte ${fecha(a.corte)}${a.cerrado ? '' : html`<br>Ejercicio sin cerrar: cifras preliminares`}`)}
    <div class="doc-meta"><div><span>Ingresos devengados</span><b>${pesos(er.totales.ingresos)}</b></div><div><span>Egresos devengados</span><b>${pesos(er.totales.egresos)}</b></div>
      <div><span>${er.totales.resultado >= 0 ? 'Remanente' : 'Déficit'}</span><b class="${er.totales.resultado < 0 ? 'neg-t' : ''}">${pesos(er.totales.resultado)}</b></div><div><span>Índice de cobranza anual</span><b>${pct(cob.indice)}</b></div>
      <div><span>Bancos y caja al inicio</span><b>${pesos(fl.inicial)}</b></div><div><span>Bancos y caja al corte</span><b>${pesos(fl.final)}</b></div><div><span>Fondo de reserva al corte</span><b>${pesos(fr.final)}</b></div><div><span>Cartera vencida al corte</span><b>${pesos(ca.resumen.vencido)}</b></div></div>
    <h3>1. Estado de resultados</h3>${tablaResultados(er, { meses: false })}
    <h3>2. Presupuesto aprobado contra ejercido</h3>
    ${pv.presupuesto ? tabla([{ t: 'Partida', k: r => r.nombre }, { t: 'Presupuesto anual', num: true, k: r => m(r.anual) }, { t: 'Ejercido', num: true, k: r => m(r.ejercido) }, { t: 'Disponible', num: true, k: r => html`<span class="${r.disponible < 0 ? 'neg-t' : ''}">${pesos(r.disponible)}</span>` }, { t: '%', num: true, k: r => pct(r.anual ? r.ejercido / r.anual : null, 0) }],
      pv.rows, { pie: ['Total', pesos(pv.totales.anual), pesos(pv.totales.ejercido), pesos(pv.totales.disponible), pct(pv.totales.anual ? pv.totales.ejercido / pv.totales.anual : null, 0)] }) : html`<p class="muted">No hay presupuesto registrado para ${ej}.</p>`}
    ${pv.presupuesto?.acta ? html`<p class="small muted">Aprobado en: ${pv.presupuesto.acta}.</p>` : ''}
    <h3>3. Cobranza</h3>
    ${tabla([{ t: 'Mes', k: x => mesNombre(x.periodo) }, { t: 'Emitido', num: true, k: x => m(x.emitido) }, { t: 'Cobrado de lo emitido', num: true, k: x => m(x.cobrado) }, { t: 'Índice', num: true, k: x => pct(x.indice) }, { t: 'Recaudado en el mes', num: true, k: x => m(x.recaudado) }],
      cob.meses.filter(x => x.emitido || x.recaudado), { pie: ['Año', pesos(cob.emitido), pesos(cob.cobrado), pct(cob.indice), pesos(cob.meses.reduce((s, x) => s + x.recaudado, 0))] })}
    <h3>4. Fondo de reserva</h3>
    <ul class="rows"><li><span class="t">Saldo al inicio del ejercicio</span><span class="v">${pesos(fr.inicial)}</span></li><li><span class="t">Aportaciones del ejercicio</span><span class="v">${pesos(fr.aportaciones)}</span></li><li><span class="t">Aplicaciones aprobadas</span><span class="v">${pesos(fr.aplicaciones)}</span></li><li><span class="t"><b>Saldo al corte</b></span><span class="v"><b>${pesos(fr.final)}</b></span></li></ul>
    ${fr.usos.length ? tabla([{ t: 'Uso', k: x => html`E-${x.folio} · ${x.concepto}` }, { t: 'Fecha', k: x => fecha(x.fecha) }, { t: 'Importe', num: true, k: x => m(x.total_cents) }], fr.usos) : ''}
    <h3>5. Cartera vencida y morosidad</h3>
    <p class="small">${ca.resumen.morosas} de ${ca.resumen.unidades} unidades (${pct(ca.resumen.pct_morosidad)}) con saldo vencido.</p>
    ${tabla([{ t: 'Unidad', k: x => html`${x.clave}${x.convenio ? ' · convenio' : ''}` }, { t: 'Propietario', k: x => x.propietario || '—' }, { t: 'Cuotas vencidas', num: true, k: x => x.meses }, { t: 'Vencido', num: true, k: x => m(x.vencido) }], ca.morosos, { vacio: 'Sin unidades morosas.', pie: ['Total', '', '', pesos(ca.resumen.vencido)] })}
    <h3>6. Balance general al corte</h3>${tablaBalance(a.balance)}
    <div class="firma"><div>Administración</div><div>Comité de vigilancia</div></div>
    <footer class="doc-foot"><span>Informe generado del libro contable de partida doble; todas las cifras son trazables a sus pólizas.</span><span>Indiviso CMS</span></footer></article>`;
  const anios = [ej + 1, ej, ej - 1, ej - 2].filter(x => x <= +hoy().slice(0, 4));
  mount(el, html`<form class="filters" data-f><label class="field"><span>Ejercicio</span><select name="ejercicio" data-auto>${anios.map(x => html`<option ${x === ej ? raw('selected') : ''}>${x}</option>`)}</select></label><button class="btn">Ver</button><span class="spacer"></span><button class="btn primary" type="button" data-action="imprimir">Imprimir informe para asamblea</button></form>${doc}`);
  return doc;
}
