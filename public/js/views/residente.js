// Portal del residente: su saldo, cómo pagar, recibos y transparencia.
import { S, capi, html, mount, $, pesos, fecha, fechaHora, hoy, tabla, m, pill, ESTADO_PAGO, METODOS, toast, dialogo, val, pesosDe, idem, cargando, imprimir, pct, mesCorto } from '../ui.js';
import { docEstadoCuenta, imprimirRecibo } from './comun.js';

export async function render(el, ctx) {
  cargando(el);
  const d = await capi('/mi');
  const c = S.condos.find(x => x.id === S.cid);
  if (!d.unidades.length) return mount(el, html`<div class="title-row"><div><h1>${c.nombre}</h1><p class="sub">Su usuario aún no está vinculado a una unidad. Contacte a la administración.</p></div></div>`);
  const t = d.transparencia;
  mount(el, html`
    <div class="title-row"><div><p class="crumbs">${c.nombre}</p><h1>Mi estado de cuenta</h1><p class="sub">Hola, ${S.me.nombre.split(' ')[0]}. Aquí ve su saldo, sus recibos y cómo se usan las cuotas del condominio.</p></div></div>
    ${d.unidades.map(u => html`<div class="grid top">
      <section class="panel c5"><header><h2>Unidad ${u.unidad.clave}</h2>${pill(u.saldo_final > 0 ? ['Saldo pendiente', u.pendientes.some(p => p.vencimiento < hoy()) ? 'neg' : 'warn'] : u.saldo_final < 0 ? ['Saldo a favor', 'pos'] : ['Al corriente', 'pos'])}</header>
        <div class="hero-fig"><span class="kpi-value">${pesos(Math.abs(u.saldo_final))}</span><span class="of">${u.saldo_final > 0 ? 'por pagar' : u.saldo_final < 0 ? 'a su favor' : 'sin adeudo'}</span></div>
        ${u.pendientes.length ? html`<ul class="rows top-gap">${u.pendientes.map(p => html`<li><span class="t"><b>${p.concepto}</b><span>vence ${fecha(p.vencimiento)}</span></span><span class="v">${pesos(p.saldo_cents)}</span></li>`)}</ul>` : ''}
        <h3 class="top-gap">Cómo pagar</h3>
        <p class="small">Transferencia a ${d.bancos.map(b => `${b.banco} (${b.nombre}) CLABE ${b.clabe_mask || ''}`).join(' · ')} con la referencia <b class="num">${u.unidad.referencia}</b>.</p>
        <div class="actions top-gap"><button class="btn" data-action="estado" data-u="${u.unidad.id}">Descargar estado de cuenta</button></div>
      </section>
      <section class="panel c7 flush"><header><h2>Mis pagos</h2></header>
        ${tabla([{ t: 'Fecha', k: p => fecha(p.fecha) }, { t: 'Método', k: p => html`${METODOS[p.metodo]}<span class="sub-t">${p.referencia || ''}</span>` }, { t: 'Importe', num: true, k: p => m(p.monto_cents) },
          { t: 'Estado', k: p => html`${pill(ESTADO_PAGO[p.estado])}${p.motivo && p.estado === 'rechazado' ? html`<span class="sub-t">${p.motivo}</span>` : ''}` },
          { t: '', k: p => p.folio && p.estado === 'aplicado' ? html`<button class="link" data-action="recibo" data-id="${p.id}">Recibo R-${p.folio}</button>` : '' }], u.pagos.slice(0, 8), { vacio: 'Aún no hay pagos.' })}</section></div>`)}
    <section class="panel top-gap"><header><h2>Transparencia ${t.ejercicio}</h2><span class="meta">Cifras del libro contable del condominio</span></header>
      <div class="kpis"><div class="kpi"><p class="label">Ingresos del año</p><p class="kpi-value md">${pesos(t.ingresos)}</p></div><div class="kpi"><p class="label">Gastos del año</p><p class="kpi-value md">${pesos(t.egresos)}</p></div>
        <div class="kpi"><p class="label">Fondo de reserva</p><p class="kpi-value md">${pesos(t.fondo_reserva)}</p></div>
        <div class="kpi"><p class="label">Cobranza del año</p><p class="kpi-value md">${pct(t.cobranza.reduce((a, x) => a + x.cobrado, 0) / (t.cobranza.reduce((a, x) => a + x.emitido, 0) || 1))}</p><p class="sub">de las cuotas emitidas</p></div></div>
      <div class="grid top top-gap"><div class="c6"><h3>En qué se gastó</h3><ul class="rows top-gap">${t.partidas.slice(0, 8).map(p => html`<li><span class="t">${p.nombre}</span><span class="v">${pesos(p.total)}</span></li>`)}</ul></div>
        <div class="c6"><h3>Recaudación por mes</h3><div class="chart" id="ch-res"></div></div></div></section>`);
  window.Charts?.bars($('#ch-res', el), { labels: t.cobranza.map(x => mesCorto(x.periodo)), values: t.cobranza.map(x => x.recaudado / 100), highlight: t.cobranza.length - 1, format: v => '$' + Math.round(v).toLocaleString('es-MX'), tickFormat: window.Charts.fmt.compact, height: 180 });
  ctx.acciones({
    recibo: dd => imprimirRecibo(dd.id),
    estado: async dd => { const u = d.unidades.find(x => x.unidad.id === +dd.u); const full = await capi(`/estado-cuenta/${u.unidad.id}`); imprimir(docEstadoCuenta(full)); },
  });
}
