// Tablero: ¿cómo va la cobranza del mes y quién debe?
import { S, capi, html, mount, $, pesos, pesosCortos, pct, mesNombre, mesCorto, periodoActual, puede, barra, toast, confirmar, cargando, entero } from '../ui.js';
import { dialogoPago, invalidar } from './comun.js';

export function estadoUnidad(u) {
  if (u.vencido > 0) return u.dias_max > 90 ? 'd90' : u.dias_max > 30 ? 'd60' : 'd30';
  if (u.adeudo > 0) return 'pend';
  if (u.saldo_favor > 0) return 'favor';
  return 'pagado';
}
const ETIQUETA = { pagado: 'Al corriente', pend: 'Cuota del mes por vencer', favor: 'Con saldo a favor', d30: 'Vencido 1–30 días', d60: 'Vencido 31–90 días', d90: 'Vencido más de 90 días' };

// La fachada: cada torre dibujada piso por piso; cada unidad con su estado de cobranza.
export function fachada(unidades, cid) {
  const torres = new Map();
  for (const u of unidades.filter(x => x.activo)) {
    const t = u.torre || 'Unidades';
    const dig = (u.clave.match(/(\d+)\s*$/) || [, ''])[1];
    const piso = dig.length > 2 ? +dig.slice(0, -2) : dig.length ? +dig[0] : 0;
    if (!torres.has(t)) torres.set(t, new Map());
    const pisos = torres.get(t);
    if (!pisos.has(piso)) pisos.set(piso, []);
    pisos.get(piso).push(u);
  }
  return html`<div class="facade">${[...torres].map(([t, pisos]) => {
    const cols = Math.min(8, Math.max(...[...pisos.values()].map(p => p.length)));
    return html`<div class="tower"><h3>${t}</h3><div class="floors">${[...pisos].sort((a, b) => b[0] - a[0]).map(([p, us]) => html`
      <div class="floor cols-${cols}"><span class="lvl">${p || ''}</span>${us.sort((a, b) => a.clave.localeCompare(b.clave)).map(u => {
        const st = estadoUnidad(u);
        const monto = u.vencido > 0 ? pesosCortos(u.vencido) : u.adeudo > 0 ? pesosCortos(u.adeudo) : u.saldo_favor > 0 ? `+${pesosCortos(u.saldo_favor)}` : 'al corriente';
        return html`<a class="u ${st === 'pend' ? '' : st} ${u.convenio ? 'convenio' : ''}" href="#/c/${cid}/unidades/${u.id}" title="${u.clave} · ${u.propietario || ''} · ${ETIQUETA[st]}${u.convenio ? ' · con convenio' : ''}">
          <b>${u.clave.replace(/^.*?-/, '')}</b><span>${monto}</span></a>`;
      })}</div>`)}</div></div>`;
  })}</div>`;
}
export const leyendaFachada = html`<div class="legend"><span><i class="pagado"></i>Al corriente</span><span><i class="pend"></i>Por vencer</span><span><i class="favor"></i>Saldo a favor</span><span><i class="d30"></i>1–30 días</span><span><i class="d60"></i>31–90</span><span><i class="d90"></i>90+</span><span><i class="convenio"></i>Convenio</span></div>`;

export function barraAntiguedad(a) {
  const parts = [a.por_vencer, a.d30, a.d60, a.d90, a.d90mas];
  const tot = parts.reduce((x, y) => x + y, 0) || 1;
  let x = 0;
  return html`<div class="aging-bar"><svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">${parts.map((p, i) => { const w = p / tot * 100; const r = html`<rect class="b${i}" x="${x.toFixed(3)}" width="${Math.max(0, w - 0.4).toFixed(3)}" height="12"/>`; x += w; return r; })}</svg></div>`;
}

export async function render(el, ctx) {
  cargando(el);
  const periodo = periodoActual();
  const [t, us] = await Promise.all([capi(`/tablero?periodo=${periodo}`), capi('/unidades')]);
  const k = t.kpis, p = t.pendientes;
  const a = t.antiguedad;
  const vencidoTop = t.top_morosos.slice(0, 4).reduce((s, x) => s + x.vencido, 0);
  const hallazgo = [
    k.emitido ? html`Se ha cobrado <b>${pct(k.indice_cobranza, 0)}</b> de las cuotas emitidas este mes.` : html`Aún no se emiten las cuotas de ${mesNombre(periodo)}.`,
    k.cartera_vencida ? html` ${k.unidades_morosas > 4 ? html`Cuatro unidades concentran <b>${pesos(vencidoTop)}</b> de <b>${pesos(k.cartera_vencida)}</b> vencido.` : html`${k.unidades_morosas === 1 ? 'Una unidad debe' : `Las ${k.unidades_morosas} unidades con atraso deben`} <b>${pesos(k.cartera_vencida)}</b> vencido.`}` : ' No hay cartera vencida.',
  ];
  const presPct = k.presupuesto_mes ? k.egresos_mes / k.presupuesto_mes : null;
  mount(el, html`
    <div class="title-row">
      <div><p class="crumbs">${t.condominio.nombre}</p><h1>Cobranza de ${mesNombre(periodo)}</h1><p class="sub">${hallazgo}</p></div>
      <div class="actions">
        ${puede('capturar') && !p.cuotas_mes_emitidas ? html`<button class="btn" data-action="emitir">Emitir cuotas de ${mesNombre(periodo)}</button>` : ''}
        ${puede('capturar') ? html`<button class="btn primary" data-action="pago">Registrar pago</button>` : ''}
      </div>
    </div>

    <div class="grid">
      <section class="panel c8" aria-labelledby="h-cob">
        <header><h2 id="h-cob">Cobranza del mes</h2><span class="meta">Cuotas ordinarias y extraordinarias de ${mesNombre(periodo)}</span></header>
        <div class="hero-fig"><span class="kpi-value">${pesos(k.cobrado)}</span><span class="of">cobrado de ${pesos(k.emitido)} emitido · ${pct(k.indice_cobranza)}</span></div>
        <div class="meter-row">${barra(k.indice_cobranza)}</div>
        <div class="kpis kpis-tight">
          <div class="kpi"><p class="label">Recaudado en el mes</p><p class="kpi-value md">${pesos(k.recaudado)}</p><p class="sub">incluye adeudos de meses anteriores</p></div>
          <div class="kpi"><p class="label">Cartera vencida</p><p class="kpi-value md">${pesos(k.cartera_vencida)}</p><p class="sub"><b>${k.unidades_morosas}</b> de ${k.unidades} unidades · ${pct(k.pct_morosidad)}</p></div>
          <div class="kpi"><p class="label">Saldos a favor</p><p class="kpi-value md ${k.saldo_favor ? '' : 'zero'}">${pesos(k.saldo_favor)}</p><p class="sub">pagos anticipados por aplicar</p></div>
        </div>
        <div class="chart-head"><h3>Recaudación mensual</h3><span class="meta">últimos 12 meses · ${mesNombre(periodo)} en curso</span></div>
        <div class="chart" id="ch-recaudo"></div>
      </section>

      <div class="stack c4">
        <section class="panel" aria-labelledby="h-pend">
          <header><h2 id="h-pend">Por atender</h2></header>
          <ul class="rows queue">
            ${cola(`#/c/${S.cid}/egresos/aprobar`, 'Egresos por aprobar', p.egresos_por_aprobar)}
            ${cola(`#/c/${S.cid}/egresos/egresos?estado=aprobado`, 'Egresos aprobados por pagar', p.egresos_por_pagar)}
            ${cola(`#/c/${S.cid}/bancos`, 'Movimientos bancarios sin conciliar', p.movs_sin_conciliar)}
            <li><a href="#/c/${S.cid}/cierres"><span>${p.periodo_anterior_abierto ? 'Hay meses anteriores sin cerrar' : 'Meses anteriores cerrados'}</span><span class="n ${p.periodo_anterior_abierto ? '' : 'ok'}">${p.periodo_anterior_abierto ? 'Cerrar' : '✓'}</span></a></li>
          </ul>
        </section>
        <section class="panel" aria-labelledby="h-ban">
          <header><h2 id="h-ban">Bancos</h2><span class="meta">saldo en libros</span></header>
          <ul class="rows">
            ${k.bancos.bancos.map(b => html`<li><span class="t"><b>${b.banco} · ${b.nombre}</b><span>${b.numero_mask || ''}${b.fondo === 'reserva' ? ' · fondo de reserva' : ''}</span></span><span class="v">${pesos(b.saldo_cents)}</span></li>`)}
            <li><span class="t"><b>Caja</b><span>efectivo por depositar</span></span><span class="v ${k.bancos.caja ? '' : 'zero'}">${pesos(k.bancos.caja)}</span></li>
            <li><span class="t"><b>Fondo de reserva</b><span>patrimonio comprometido</span></span><span class="v">${pesos(k.fondo_reserva)}</span></li>
          </ul>
        </section>
      </div>

      <section class="panel c7" aria-labelledby="h-fach">
        <header><h2 id="h-fach">Fachada de cobranza</h2>${leyendaFachada}</header>
        ${fachada(us, S.cid)}
      </section>

      <div class="stack c5">
        <section class="panel" aria-labelledby="h-age">
          <header><h2 id="h-age">Antigüedad de saldos</h2><a class="card-link link" href="#/c/${S.cid}/morosidad">Ver morosidad</a></header>
          ${barraAntiguedad(a)}
          <ul class="rows aging-list">
            ${[['Por vencer', a.por_vencer, 0], ['1 a 30 días', a.d30, 1], ['31 a 60 días', a.d60, 2], ['61 a 90 días', a.d90, 3], ['Más de 90 días', a.d90mas, 4]].map(([l, v, i]) => html`<li><span class="t"><span class="sw b${i}"></span>${l}</span><span class="v ${v ? '' : 'zero'}">${pesos(v)}</span></li>`)}
          </ul>
        </section>
        <section class="panel" aria-labelledby="h-top">
          <header><h2 id="h-top">Mayores adeudos</h2></header>
          <ul class="rows">${t.top_morosos.length ? t.top_morosos.map(u => html`<li><a class="row-link t" href="#/c/${S.cid}/unidades/${u.id}"><span><b>${u.clave}${u.convenio ? ' · convenio' : ''}</b><span>${u.propietario || '—'}</span></span></a><span class="v">${pesos(u.vencido)}<span>${u.meses ? `${u.meses} ${u.meses === 1 ? 'cuota' : 'cuotas'} · ` : ''}${u.dias} días</span></span></li>`)
            : html`<li class="empty-state">Ninguna unidad con saldo vencido.</li>`}</ul>
        </section>
      </div>

      <section class="panel c7" aria-labelledby="h-ie">
        <header><h2 id="h-ie">Ingresos y egresos devengados</h2><div class="chart-legend"><span><span class="sw acc"></span>Ingresos</span><span><span class="sw ink"></span>Egresos</span></div></header>
        <div class="chart" id="ch-ie"></div>
      </section>
      <section class="panel c5" aria-labelledby="h-gas">
        <header><h2 id="h-gas">Gasto de ${mesNombre(periodo)}</h2><a class="card-link link" href="#/c/${S.cid}/presupuesto">Presupuesto</a></header>
        <div class="hbar"><span><b>${pesos(k.egresos_mes)}</b> <span class="muted">de ${pesos(k.presupuesto_mes)} presupuestado</span></span><span class="num">${pct(presPct, 0)}</span>${barra(presPct, { cls: presPct > 1 ? 'neg' : 'ink' })}</div>
        <ul class="rows top-gap">${t.egresos_partida.slice(0, 6).map(e => html`<li><span class="t">${e.nombre}</span><span class="v">${pesos(e.total)}</span></li>`)}
          ${t.egresos_partida.length ? '' : html`<li class="empty-state">Sin egresos registrados este mes.</li>`}</ul>
        <p class="meta top-gap">Ejercido en el año: ${pesos(k.ejercido_anual)} de ${pesos(k.presupuesto_anual)} (${pct(k.presupuesto_anual ? k.ejercido_anual / k.presupuesto_anual : null, 0)}).</p>
      </section>
    </div>`);

  const serie = t.serie;
  const pesosFmt = v => '$' + entero(v);
  window.Charts?.bars($('#ch-recaudo', el), { labels: serie.map(s => mesCorto(s.periodo)), values: serie.map(s => s.recaudado / 100), highlight: serie.length - 1, format: pesosFmt, tickFormat: window.Charts.fmt.compact, height: 170 });
  window.Charts?.line($('#ch-ie', el), { labels: serie.map(s => mesCorto(s.periodo)), series: [{ name: 'Ingresos', values: serie.map(s => s.ingresos / 100) }, { name: 'Egresos', values: serie.map(s => s.egresos / 100), muted: true }], format: pesosFmt, tickFormat: window.Charts.fmt.compact, height: 200 });

  ctx.acciones({
    pago: () => dialogoPago({ onOk: () => ctx.recargar() }),
    emitir: async () => {
      if (!await confirmar(`Emitir cuotas de ${mesNombre(periodo)}`, 'Se generará la cuota ordinaria de cada unidad activa y se aplicarán automáticamente los saldos a favor. Si ya existe la cuota de una unidad, no se duplica.', { label: 'Emitir cuotas' })) return;
      const r = await capi('/cobranza/emitir', { method: 'POST', body: { periodo } });
      invalidar(); toast(`${r.emitidos} cuotas emitidas por ${pesos(r.total)}${r.omitidos ? ` · ${r.omitidos} ya existían` : ''}`); ctx.recargar();
    },
  });
}

const cola = (href, label, n) => html`<li><a href="${href}"><span>${label}</span><span class="n ${n ? '' : 'ok'}">${n ? n : '0'}</span></a></li>`;
