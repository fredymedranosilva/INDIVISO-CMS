// Consolidado de la administradora: todos los condominios a los que el usuario tiene acceso financiero.
import { api, html, mount, pesos, pct, mesNombre, periodoActual, tabla, m, cargando, barra } from '../ui.js';

export async function render(el) {
  cargando(el);
  const p = periodoActual();
  const rows = await api(`/api/consolidado?periodo=${p}`);
  const s = k => rows.reduce((a, r) => a + (typeof k === 'function' ? k(r) : r[k]), 0);
  const emit = s('emitido'), cob = s('cobrado');
  mount(el, html`
    <div class="title-row"><div><h1>Consolidado de ${mesNombre(p)}</h1><p class="sub">${rows.length} condominios · se ha cobrado <b>${pct(emit ? cob / emit : null, 0)}</b> de lo emitido en conjunto; cartera vencida total <b>${pesos(s('cartera_vencida'))}</b>.</p></div></div>
    <section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Emitido en el mes</p><p class="kpi-value md">${pesos(emit)}</p></div>
      <div class="kpi"><p class="label">Cobrado de lo emitido</p><p class="kpi-value md">${pesos(cob)}</p></div>
      <div class="kpi"><p class="label">Recaudado en el mes</p><p class="kpi-value md">${pesos(s('recaudado'))}</p></div>
      <div class="kpi"><p class="label">Bancos y caja</p><p class="kpi-value md">${pesos(s(r => r.bancos.total))}</p></div>
      <div class="kpi"><p class="label">Fondos de reserva</p><p class="kpi-value md">${pesos(s('fondo_reserva'))}</p></div></div></section>
    <section class="panel flush top-gap"><header><h2>Por condominio</h2></header>
      ${tabla([
        { t: 'Condominio', k: r => html`<a class="link" href="#/c/${r.id}/tablero"><b>${r.nombre}</b></a><span class="sub-t">${r.ciudad || ''} · ${r.unidades} unidades</span>` },
        { t: 'Cobranza del mes', k: r => html`<div class="hbar"><span>${pesos(r.cobrado)} de ${pesos(r.emitido)}</span><span class="num">${pct(r.indice_cobranza, 0)}</span>${barra(r.indice_cobranza)}</div>` },
        { t: 'Cartera vencida', num: true, k: r => html`${m(r.cartera_vencida)}<span class="sub-t">${r.unidades_morosas} unidades · ${pct(r.pct_morosidad, 0)}</span>` },
        { t: 'Bancos', num: true, k: r => m(r.bancos.total), cls: 'hide-m' },
        { t: 'Fondo de reserva', num: true, k: r => m(r.fondo_reserva), cls: 'hide-m' },
        { t: 'Egresos del mes', num: true, k: r => html`${m(r.egresos_mes)}<span class="sub-t">de ${pesos(r.presupuesto_mes)}</span>`, cls: 'hide-m' },
        { t: 'Por atender', k: r => { const n = r.pendientes.pagos_por_validar + r.pendientes.egresos_por_aprobar; return n ? html`<span class="pill warn">${n} pendientes</span>` : html`<span class="faint">—</span>`; } },
      ], rows, { pie: ['Total', '', pesos(s('cartera_vencida')), pesos(s(r => r.bancos.total)), pesos(s('fondo_reserva')), pesos(s('egresos_mes')), ''] })}</section>`);
}
