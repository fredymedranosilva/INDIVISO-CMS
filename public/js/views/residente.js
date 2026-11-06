// Portal del residente: su saldo, cómo pagar, reportar un pago con comprobante, recibos y transparencia.
import { S, capi, html, mount, $, pesos, fecha, fechaHora, hoy, tabla, m, pill, ESTADO_PAGO, METODOS, toast, dialogo, val, pesosDe, idem, cargando, imprimir, pct, mesCorto } from '../ui.js';
import { subirArchivo, docEstadoCuenta, imprimirRecibo } from './comun.js';

export async function render(el, ctx) {
  cargando(el);
  const [d, avisos, eventos, encuestas] = await Promise.all([capi('/mi'), capi('/comunidad?tipo=aviso'), capi('/comunidad?tipo=evento'), capi('/encuestas')]);
  const pendientesVoto = encuestas.filter(e => e.estado === 'abierta' && !e.mis_votos.length);
  const proximos = eventos.filter(e => e.fecha >= hoy()).slice(0, 3);
  const c = S.condos.find(x => x.id === S.cid);
  if (!d.unidades.length) return mount(el, html`<div class="title-row"><div><h1>${c.nombre}</h1><p class="sub">Su usuario aún no está vinculado a una unidad. Contacte a la administración.</p></div></div>`);
  const t = d.transparencia;
  mount(el, html`
    <div class="title-row"><div><p class="crumbs">${c.nombre}</p><h1>Mi estado de cuenta</h1><p class="sub">Hola, ${S.me.nombre.split(' ')[0]}. Aquí ve su saldo, sus recibos y cómo se usan las cuotas del condominio.</p></div></div>
    ${pendientesVoto.length ? html`<p class="note warn top-gap">Hay ${pendientesVoto.length === 1 ? 'una votación abierta' : `${pendientesVoto.length} votaciones abiertas`}: «${pendientesVoto[0].pregunta}». <a class="link" href="#/c/${S.cid}/comunidad/encuestas">Votar</a></p>` : ''}
    ${avisos.length || proximos.length ? html`<div class="grid top">
      <section class="panel c7"><header><h2>Avisos</h2><a class="link" href="#/c/${S.cid}/comunidad/avisos">Ver todos</a></header>
        <ul class="rows">${avisos.slice(0, 3).map(a => html`<li><span class="t"><b>${a.titulo}</b><span>${fechaHora(a.created_at)}</span></span>${a.fijado ? pill(['Importante', 'warn']) : ''}</li>`)}${avisos.length ? '' : html`<li><span class="t faint">Sin avisos.</span></li>`}</ul></section>
      <section class="panel c5"><header><h2>Próximos eventos</h2><a class="link" href="#/c/${S.cid}/comunidad/calendario">Calendario</a></header>
        <ul class="rows">${proximos.map(e => html`<li><span class="t"><b>${e.titulo}</b><span>${e.lugar || ''}</span></span><span class="v">${fecha(e.fecha)}<span>${e.hora || ''}</span></span></li>`)}${proximos.length ? '' : html`<li><span class="t faint">Sin eventos próximos.</span></li>`}</ul></section></div>` : ''}
    ${d.unidades.map(u => html`<div class="grid top">
      <section class="panel c5"><header><h2>Unidad ${u.unidad.clave}</h2>${pill(u.saldo_final > 0 ? ['Saldo pendiente', u.pendientes.some(p => p.vencimiento < hoy()) ? 'neg' : 'warn'] : u.saldo_final < 0 ? ['Saldo a favor', 'pos'] : ['Al corriente', 'pos'])}</header>
        <div class="hero-fig"><span class="kpi-value">${pesos(Math.abs(u.saldo_final))}</span><span class="of">${u.saldo_final > 0 ? 'por pagar' : u.saldo_final < 0 ? 'a su favor' : 'sin adeudo'}</span></div>
        ${u.pendientes.length ? html`<ul class="rows top-gap">${u.pendientes.map(p => html`<li><span class="t"><b>${p.concepto}</b><span>vence ${fecha(p.vencimiento)}</span></span><span class="v">${pesos(p.saldo_cents)}</span></li>`)}</ul>` : ''}
        <h3 class="top-gap">Cómo pagar</h3>
        <p class="small">Transferencia a ${d.bancos.map(b => `${b.banco} (${b.nombre}) CLABE ${b.clabe_mask || ''}`).join(' · ')} con la referencia <b class="num">${u.unidad.referencia}</b>. Después reporte su pago aquí con el comprobante.</p>
        <div class="actions top-gap"><button class="btn primary" data-action="reportar" data-u="${u.unidad.id}" data-saldo="${u.saldo_final}">Reportar un pago</button><button class="btn" data-action="estado" data-u="${u.unidad.id}">Descargar estado de cuenta</button></div>
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
    reportar: dd => {
      const key = idem(); let arch = null;
      dialogo({
        titulo: 'Reportar un pago', cuerpo: html`<p class="lead">La administración validará su pago contra el estado de cuenta bancario; verá el recibo aquí cuando se aplique.</p><div class="form-grid">
          <label class="field"><span>Importe pagado</span><input name="monto" class="num-in" inputmode="decimal" value="${+dd.saldo > 0 ? (+dd.saldo / 100).toFixed(2) : ''}" required></label>
          <label class="field"><span>Fecha del pago</span><input type="date" name="fecha" value="${hoy()}" max="${hoy()}" required></label>
          <label class="field"><span>Método</span><select name="metodo"><option value="transferencia">Transferencia</option><option value="deposito">Depósito</option></select></label>
          <label class="field"><span>Clave de rastreo o folio</span><input name="ref" maxlength="60" required></label>
          <label class="field full"><span>Comprobante (PDF o imagen, hasta 5 MB)</span><input type="file" name="comp" accept=".pdf,.png,.jpg,.jpeg" required></label></div>`,
        acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Enviar reporte', primary: true }],
        onSubmit: async f => {
          if (!f.comp.files[0]) throw new Error('Adjunte su comprobante.');
          arch ??= (await subirArchivo(f.comp.files[0])).id;
          await capi('/mi/pagos', { method: 'POST', body: { unidad_id: +dd.u, monto_cents: pesosDe(f, 'monto'), fecha: val(f, 'fecha'), metodo: f.metodo.value, referencia: val(f, 'ref'), comprobante_id: arch, idem_key: key, cuenta_banco_id: d.bancos[0]?.id ?? null } });
          toast('Pago reportado. La administración lo validará.'); ctx.recargar();
        },
      });
    },
  });
}
