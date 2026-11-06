// Estados de cuenta por unidad: anual, mensual, histórico o personalizado; recibos, recargos y avisos de cobro en PDF.
import { S, capi, html, raw, mount, $, hoy, cargando, imprimir, toast, pesos, fecha, puede, dialogo, val, pesosDe, leerPeriodo, selectorPeriodo, filtrosAuto, ICON } from '../ui.js';
import { unidades, docEstadoCuenta, dialogoPago, imprimirConstancia, invalidar } from './comun.js';

const TIPO = { cuota: 'Cuota', extraordinaria: 'Extraordinaria', recargo: 'Recargo', multa: 'Multa', otro: 'Cargo', pago: 'Pago', descuento: 'Descuento', cancelacion: 'Cancelación', cancelacion_pago: 'Pago cancelado', saldo_inicial: 'Saldo inicial', cargo: 'Cargo', abono: 'Abono' };
const ESTATUS = { pagada: 'Pagada', parcial: 'Pago parcial', pendiente: 'No pagada', cancelada: 'Cancelada', condonada: 'Condonada', aplicado: 'Aplicado', cancelado: 'Cancelado' };
const MODOS = [['anual', 'Anual'], ['mensual', 'Mensual'], ['historico', 'Histórico'], ['personalizado', 'Personalizado']];
const saldoCelda = s => s < 0 ? html`<span class="saldo-favor">+ ${pesos(-s)}</span>` : pesos(s);
const informes = () => import('../informes.js');

function rangoDe(modo, q) {
  if (modo === 'historico') return { desde: '2000-01-01', hasta: hoy(), texto: 'Histórico' };
  if (modo === 'personalizado') { const desde = q.get('desde') || `${hoy().slice(0, 7)}-01`, hasta = q.get('hasta') || hoy(); return { desde, hasta: hasta > hoy() ? hoy() : hasta, texto: `${fecha(desde)} a ${fecha(hasta)}` }; }
  const p = leerPeriodo(q, { mes: modo === 'anual' ? 0 : undefined });
  if (modo === 'anual') { const d = `${p.anio}-01-01`, h = `${p.anio}-12-31` > hoy() ? hoy() : `${p.anio}-12-31`; return { desde: d, hasta: h, p: { ...p, mes: 0 }, texto: `Año ${p.anio}` }; }
  return { desde: p.desde, hasta: p.hasta, p, texto: p.texto };
}

export async function render(el, ctx) {
  const [, qs] = (ctx.params[0] || '').split('?');
  const q = new URLSearchParams(qs || '');
  const us = (await unidades()).filter(u => u.activo);
  const uid = +(q.get('u') || us[0]?.id);
  const modo = MODOS.some(([k]) => k === q.get('modo')) ? q.get('modo') : 'anual';
  const r = rangoDe(modo, q);
  cargando(el);
  const d = await capi(`/estado-cuenta/${uid}?desde=${r.desde}&hasta=${r.hasta}`);
  const u = d.unidad, prop = d.personas.filter(p => p.rol === 'propietario').map(p => p.nombre).join(', ') || '—', email = d.personas.find(p => p.email)?.email;
  const pagos = d.movimientos.filter(x => x.tipo === 'pago' && x.recibo);
  const T = d.totales;
  const controles = modo === 'anual' ? html`<label class="field"><span>Año</span><select name="anio" data-auto>${Array.from({ length: 6 }, (_, i) => +hoy().slice(0, 4) - i).map(y => html`<option ${y === r.p.anio ? raw('selected') : ''}>${y}</option>`)}</select></label>`
    : modo === 'mensual' ? selectorPeriodo(r.p, { todo: false })
    : modo === 'personalizado' ? html`<label class="field"><span>Desde</span><input type="date" name="desde" value="${r.desde}"></label><label class="field"><span>Hasta</span><input type="date" name="hasta" value="${r.hasta}" max="${hoy()}"></label><button class="btn">Ver</button>` : '';
  mount(el, html`
    <div class="title-row"><div><h1>Estados de cuenta</h1><p class="sub">Cada cuota con su estatus y cada pago con su recibo. Calculado del libro contable: siempre cuadra con la contabilidad.</p></div>
      <div class="actions"><button class="btn" data-action="avisosTodos">${raw(ICON.pdf)}<span>Avisos de cobro de todas</span></button><button class="btn" data-action="estadosTodos">${raw(ICON.pdf)}<span>Estados de cuenta de todas</span></button></div></div>
    <form class="filters" data-f>
      <label class="field"><span>Unidad</span><select name="u" data-auto>${us.map(x => html`<option value="${x.id}" ${x.id === uid ? raw('selected') : ''}>${x.clave} · ${x.propietario || ''}</option>`)}</select></label>
      <input type="hidden" name="modo" value="${modo}">
      <nav class="modos" aria-label="Periodo">${MODOS.map(([k, l]) => html`<a href="${ctx.base}/?u=${uid}&modo=${k}" ${k === modo ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
      ${controles}</form>
    <section class="panel">
      <div class="ec-head"><div class="quien"><b>${prop}</b><p>Unidad <b>${u.clave}</b>${u.torre ? ` · ${u.torre}` : ''} · Referencia de pago <b>${u.referencia}</b>${email ? ` · ${email}` : ''} · Periodo: ${r.texto}</p></div>
        <div class="ec-saldo"><span>${d.saldo_final > 0 ? 'Saldo pendiente' : d.saldo_final < 0 ? 'Saldo a favor' : 'Saldo'}</span><b class="${d.saldo_final > 0 ? 'debe' : d.saldo_final < 0 ? 'favor' : ''}">${pesos(Math.abs(d.saldo_final))}</b></div></div>
      <div class="ec-acciones">
        ${puede('capturar') ? html`<button class="btn primary" data-action="pago">Registrar pago</button><button class="btn" data-action="recargo">Aplicar recargo</button>` : ''}
        <button class="btn" data-action="aviso">${raw(ICON.pdf)}<span>Aviso de cobro</span></button>
        <button class="btn" data-action="pdf">${raw(ICON.pdf)}<span>Estado de cuenta</span></button>
        <button class="btn" data-action="recibos" ${pagos.length ? '' : raw('disabled')}>${raw(ICON.pdf)}<span>Recibos de pago (${pagos.length})</span></button>
        <button class="btn ghost" data-action="constancia">Constancia</button><button class="btn ghost" data-action="imprimir">${raw(ICON.imprimir)}<span>Imprimir</span></button></div>
    </section>
    <section class="panel flush top-gap"><header><h2>Movimientos</h2><span class="meta">Saldo inicial al ${fecha(r.desde)}: ${saldoCelda(d.saldo_inicial)}</span></header>
      <div class="table-wrap"><table class="tbl ec-tabla"><thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th class="r">Cargo</th><th class="r">Abono</th><th class="r">Saldo</th><th>Estatus</th><th></th></tr></thead>
        <tbody><tr><td class="nowrap">${fecha(r.desde)}</td><td></td><td><b>Saldo inicial</b></td><td></td><td></td><td class="r num"><b>${saldoCelda(d.saldo_inicial)}</b></td><td></td><td></td></tr>
        ${d.movimientos.map(x => html`<tr><td class="nowrap">${fecha(x.fecha)}</td><td><span class="tp ${x.tipo}">${TIPO[x.tipo] || x.tipo}</span></td>
          <td class="concepto">${x.concepto || ''}${x.recibo ? html`<span class="sub-t">Recibo R-${x.recibo}${x.referencia ? ` · ${x.referencia}` : ''}</span>` : ''}</td>
          <td class="r num">${x.cargo ? pesos(x.cargo) : html`<span class="faint">–</span>`}</td><td class="r num">${x.abono ? pesos(x.abono) : html`<span class="faint">–</span>`}</td><td class="r num">${saldoCelda(x.saldo)}</td>
          <td>${x.estatus ? html`<span class="est ${x.estatus}">${ESTATUS[x.estatus]}${x.estatus === 'parcial' ? html`<small>Saldo: ${pesos(x.saldo_cargo)}</small>` : ''}</span>` : ''}</td>
          <td><span class="row-actions">${x.pago_id && x.recibo ? html`<button class="link" data-action="recibo" data-id="${x.pago_id}">Recibo PDF</button>` : ''}
            ${puede('capturar') && x.cargo_id && ['pendiente', 'parcial'].includes(x.estatus) && ['cuota', 'extraordinaria', 'otro'].includes(x.tipo) ? html`<button class="link" data-action="recargo" data-cargo="${x.cargo_id}">Recargo</button>` : ''}</span></td></tr>`)}
        ${d.movimientos.length ? '' : html`<tr class="empty"><td colspan="8">Sin movimientos en el periodo.</td></tr>`}</tbody>
        <tfoot class="ec-totales"><tr><td colspan="3">Total cuotas</td><td class="r num">${pesos(T.cuotas)}</td><td colspan="4"></td></tr>
          <tr><td colspan="3">Total penalidades (recargos y multas)</td><td class="r num">${pesos(T.penalidades)}</td><td colspan="4"></td></tr>
          <tr><td colspan="3">Total pagos</td><td></td><td class="r num">${pesos(T.pagos)}</td><td colspan="3"></td></tr>
          <tr><td colspan="3">Total descuentos y bonificaciones</td><td></td><td class="r num">${pesos(T.descuentos)}</td><td colspan="3"></td></tr>
          <tr class="final"><td colspan="3">${d.saldo_final < 0 ? 'Saldo a favor' : 'Saldo pendiente'}</td><td class="r num">${pesos(d.cargos)}</td><td class="r num">${pesos(d.abonos)}</td><td class="r num">${saldoCelda(d.saldo_final)}</td><td colspan="2"></td></tr></tfoot></table></div></section>
    ${d.pendientes.length ? html`<section class="panel top-gap"><header><h2>Pendiente de pago</h2><span class="meta">${d.pendientes.length} cargos · ${pesos(d.pendientes.reduce((a, x) => a + x.saldo_cents, 0))}</span></header>
      <ul class="rows">${d.pendientes.map(x => html`<li><span class="t">${x.concepto}<span class="sub-t">Vence ${fecha(x.vencimiento)}${x.vencimiento < hoy() ? ' · vencido' : ''}</span></span><span class="v ${x.vencimiento < hoy() ? 'neg-t' : ''}">${pesos(x.saldo_cents)}</span></li>`)}</ul></section>` : ''}`);
  filtrosAuto($('[data-f]', el), p => { location.hash = `${ctx.base}/?${p}`; });
  const rangoTodos = () => `desde=${r.desde}&hasta=${r.hasta}`;
  ctx.acciones({
    imprimir: () => imprimir(docEstadoCuenta(d)),
    pdf: async () => { toast('Generando PDF…'); await (await informes()).pdfEstadoCuenta(d); },
    recibo: async dd => { const rc = await capi(`/pagos/${dd.id}/recibo`); await (await informes()).pdfRecibos([rc]); },
    recibos: async () => { toast('Generando recibos…'); const l = await capi(`/recibos?unidad=${uid}&${rangoTodos()}`); await (await informes()).pdfRecibos(l, `recibos-${u.clave}-${r.desde.slice(0, 4)}.pdf`); },
    aviso: async () => (await informes()).pdfAvisos([{ unidad: u, propietario: prop, pendientes: d.pendientes, saldo_favor: d.saldo_favor }], { condominio: d.condominio, bancos: d.bancos }),
    avisosTodos: async () => { toast('Preparando avisos de cobro…'); const all = await capi(`/estados-cuenta?desde=${r.desde}&hasta=${hoy()}`); await (await informes()).pdfAvisos(all.unidades, { condominio: all.condominio, bancos: all.bancos }); },
    estadosTodos: async () => { toast('Preparando estados de cuenta…'); const all = await capi(`/estados-cuenta?${rangoTodos()}`); await (await informes()).pdfEstadosCuenta(all); },
    constancia: () => imprimirConstancia(uid),
    pago: () => dialogoPago({ unidad: uid, onOk: () => ctx.recargar() }),
    recargo: dd => dialogoRecargo(d, dd.cargo ? +dd.cargo : null, () => { invalidar(); ctx.recargar(); }),
  });
}

// Recargo a una cuota: % sobre su importe o monto fijo.
function dialogoRecargo(d, cargoSel, onOk) {
  const cuotas = d.pendientes.filter(x => !['recargo', 'multa'].includes(x.tipo));
  if (!cuotas.length) { toast('La unidad no tiene cuotas pendientes a las que aplicar recargo.', 'error'); return; }
  const c = d.condominio, tasa = ((c.tasa_recargo_bp || 0) / 100).toFixed(2);
  dialogo({
    titulo: `Aplicar recargo · ${d.unidad.clave}`,
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Cuota</span><select name="cargo">${cuotas.map(x => html`<option value="${x.id}" data-monto="${x.monto_cents}" ${x.id === cargoSel ? raw('selected') : ''}>${x.concepto} · ${pesos(x.monto_cents)} · vence ${fecha(x.vencimiento)}</option>`)}</select></label>
      <fieldset class="field full"><span>Cálculo</span>
        <label class="check"><input type="radio" name="modo" value="porcentaje" ${c.recargo_modo === 'fijo' ? '' : raw('checked')}><span>Porcentaje sobre el importe de la cuota</span></label>
        <label class="check"><input type="radio" name="modo" value="monto" ${c.recargo_modo === 'fijo' ? raw('checked') : ''}><span>Monto fijo</span></label></fieldset>
      <label class="field"><span>Porcentaje (%)</span><input name="pct" class="num-in" inputmode="decimal" value="${tasa}"></label>
      <label class="field"><span>Monto fijo</span><input name="monto" class="num-in" inputmode="decimal" value="${c.recargo_fijo_cents ? (c.recargo_fijo_cents / 100).toFixed(2) : ''}"></label>
      <label class="field"><span>Fecha</span><input name="fecha" type="date" value="${hoy()}" max="${hoy()}"></label>
      <p class="note full" data-prev></p></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Aplicar recargo', primary: true }],
    onOpen: (dlg, f) => {
      const prev = () => {
        const base = +f.cargo.selectedOptions[0].dataset.monto, modo = f.modo.value;
        const n = modo === 'porcentaje' ? Math.round(base * Math.round(parseFloat(f.pct.value || 0) * 100) / 10000) : Math.round(parseFloat(String(f.monto.value).replace(/[$,]/g, '') || 0) * 100);
        $('[data-prev]', dlg).textContent = n > 0 ? `Se cargará un recargo de ${pesos(n)} a la unidad (uno por cuota y mes).` : 'Indique el porcentaje o el monto.';
      };
      for (const x of f.querySelectorAll('select, input')) x.addEventListener('input', prev);
      prev();
    },
    onSubmit: async f => {
      const modo = f.modo.value;
      const body = { cargo_id: +f.cargo.value, modo, fecha: val(f, 'fecha') };
      if (modo === 'porcentaje') { const n = parseFloat(val(f, 'pct')); if (!(n > 0 && n <= 50)) throw new Error('El porcentaje debe estar entre 0 y 50.'); body.porcentaje_bp = Math.round(n * 100); }
      else body.monto_cents = pesosDe(f, 'monto');
      const r = await capi('/cobranza/recargo-manual', { method: 'POST', body });
      toast(`Recargo de ${pesos(r.monto)} aplicado.`); onOk();
    },
  });
}
