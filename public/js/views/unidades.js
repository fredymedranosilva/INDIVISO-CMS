// Padrón: unidades, residentes y el expediente financiero de cada unidad.
import { S, capi, html, raw, mount, $, pesos, fecha, fechaHora, hoy, puede, tabla, m, pill, ESTADO_PAGO, METODOS, toast, dialogo, val, pesosDe, centsToInput, cargando, addMonths, periodoActual, imprimir } from '../ui.js';
import { dialogoPago, imprimirRecibo, imprimirConstancia, invalidar, docEstadoCuenta, pedirMotivo } from './comun.js';
import { estadoUnidad } from './tablero.js';

const TIPOS = ['departamento', 'casa', 'local', 'oficina', 'bodega', 'estacionamiento'];
const EST = { ocupada: 'Ocupada', vacante: 'Vacante', renta: 'En renta' };
const ESTADO_TXT = { pagado: ['Al corriente', 'pos'], pend: ['Cuota por vencer', 'neutral'], favor: ['Saldo a favor', 'pos'], d30: ['Vencido', 'neg'], d60: ['Vencido', 'neg'], d90: ['Vencido +90 días', 'neg'] };

export async function render(el, ctx) {
  if (ctx.params[0] && /^\d+$/.test(ctx.params[0])) return detalle(el, ctx, +ctx.params[0]);
  const [, qs] = (ctx.params[0] || '').split('?');
  const qtxt = new URLSearchParams(qs || '').get('q') || '';
  cargando(el);
  const us = await capi('/unidades');
  const f = qtxt.toLowerCase();
  const rows = us.filter(u => !f || `${u.clave} ${u.propietario || ''} ${u.referencia} ${u.email || ''}`.toLowerCase().includes(f));
  const totInd = us.filter(u => u.activo).reduce((a, u) => a + u.indiviso_ppm, 0);
  mount(el, html`
    <div class="title-row"><div><h1>Unidades y residentes</h1><p class="sub">${us.filter(u => u.activo).length} unidades activas · indivisos suman ${(totInd / 10000).toFixed(4)}% ${totInd === 1000000 ? '' : html`<b class="neg-t">(deben sumar 100%)</b>`} · cuota mensual total ${pesos(us.filter(u => u.activo).reduce((a, u) => a + u.cuota_cents, 0))}</p></div>
      <div class="actions">${puede('config') ? html`<button class="btn" data-action="nueva">Nueva unidad</button>` : ''}${puede('capturar') ? html`<button class="btn" data-action="persona">Agregar residente</button>` : ''}</div></div>
    <form class="filters" data-buscar><label class="search"><span class="sr">Buscar</span><input name="q" value="${qtxt}" placeholder="Unidad, propietario, referencia o correo"></label><button class="btn">Buscar</button></form>
    <section class="panel flush"><header><h2>${rows.length} unidades</h2></header>
    ${tabla([
      { t: 'Unidad', k: u => html`<b>${u.clave}</b><span class="sub-t">${u.torre || ''}</span>` },
      { t: 'Propietario', k: u => html`${u.propietario || html`<span class="faint">sin registrar</span>`}<span class="sub-t">${u.email || ''}</span>` },
      { t: 'Ocupación', k: u => u.activo ? EST[u.estado] : pill(['Inactiva', 'neutral']), cls: 'hide-m' },
      { t: 'Indiviso', num: true, k: u => `${(u.indiviso_ppm / 10000).toFixed(4)}%`, cls: 'hide-m' },
      { t: 'Cuota', num: true, k: u => m(u.cuota_cents), cls: 'hide-m' },
      { t: 'Referencia', k: u => html`<span class="num">${u.referencia}</span>`, cls: 'hide-m' },
      { t: 'Saldo', num: true, k: u => html`${u.saldo_neto > 0 ? m(u.saldo_neto) : u.saldo_neto < 0 ? html`<span class="num pos-t">+${pesos(-u.saldo_neto)}</span>` : m(0)}` },
      { t: 'Estado', k: u => pill(ESTADO_TXT[estadoUnidad(u)]) },
    ], rows, { fila: u => `data-href="#/c/${S.cid}/unidades/${u.id}" tabindex="0"`, vacio: 'Sin unidades que coincidan.' })}</section>`);
  $('[data-buscar]', el).addEventListener('submit', e => { e.preventDefault(); location.hash = `${ctx.base}/?q=${encodeURIComponent(e.target.q.value)}`; });
  ctx.acciones({ nueva: () => editarUnidad(null, ctx), persona: () => nuevaPersona(us, null, ctx) });
}

function editarUnidad(u, ctx) {
  dialogo({
    titulo: u ? `Editar unidad ${u.clave}` : 'Nueva unidad',
    cuerpo: html`<div class="form-grid">
      ${u ? '' : html`<label class="field"><span>Clave</span><input name="clave" required maxlength="20" placeholder="A-101"></label>`}
      <label class="field"><span>Torre o sección</span><input name="torre" value="${u?.torre || ''}" maxlength="30"></label>
      <label class="field"><span>Tipo</span><select name="tipo">${TIPOS.map(t => html`<option ${u?.tipo === t ? raw('selected') : ''}>${t}</option>`)}</select></label>
      <label class="field"><span>Ocupación</span><select name="estado">${Object.entries(EST).map(([k, l]) => html`<option value="${k}" ${u?.estado === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="field"><span>Superficie (m²)</span><input name="m2" type="number" min="0" value="${u?.m2 ?? ''}"></label>
      <label class="field"><span>Indiviso (%) <span class="hint">· 4 decimales</span></span><input name="ind" class="num-in" value="${u ? (u.indiviso_ppm / 10000).toFixed(4) : ''}" required></label>
      <label class="field"><span>Cuota ordinaria mensual</span><input name="cuota" class="num-in" value="${centsToInput(u?.cuota_cents)}" required></label>
      ${u ? html`<label class="check"><input type="checkbox" name="activo" ${u.activo ? raw('checked') : ''}><span>Unidad activa (genera cuotas)</span></label>` : ''}
      <label class="field full"><span>Notas</span><input name="notas" value="${u?.notas || ''}" maxlength="300"></label>
      ${u ? html`<p class="note full">El cambio de cuota aplica a partir de la siguiente emisión; las cuotas ya emitidas no se modifican.</p>` : ''}</div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', primary: true }],
    onSubmit: async f => {
      const ind = val(f, 'ind').replace('%', '');
      if (!/^\d{1,3}(\.\d{1,4})?$/.test(ind)) throw new Error('Indiviso inválido.');
      const body = { torre: val(f, 'torre') || null, tipo: f.tipo.value, estado: f.estado.value, m2: f.m2.value ? Math.round(+f.m2.value) : null, indiviso_ppm: Math.round(parseFloat(ind) * 10000), cuota_cents: pesosDe(f, 'cuota', { cero: true }), notas: val(f, 'notas') || null };
      if (u) await capi(`/unidades/${u.id}`, { method: 'PUT', body: { ...body, activo: f.activo.checked } });
      else await capi('/unidades', { method: 'POST', body: { ...body, clave: val(f, 'clave') } });
      invalidar(); toast('Unidad guardada.'); ctx.recargar();
    },
  });
}

function nuevaPersona(us, unidadId, ctx) {
  dialogo({
    titulo: 'Agregar residente',
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Nombre completo</span><input name="nombre" required maxlength="120"></label>
      <label class="field"><span>Correo</span><input name="email" type="email" maxlength="120"></label>
      <label class="field"><span>Teléfono</span><input name="tel" maxlength="30"></label>
      <label class="field"><span>Unidad</span><select name="unidad">${us.map(u => html`<option value="${u.id}" ${u.id === unidadId ? raw('selected') : ''}>${u.clave}</option>`)}</select></label>
      <label class="field"><span>Relación</span><select name="rol"><option value="propietario">Propietario</option><option value="inquilino">Inquilino</option><option value="responsable">Responsable de pago</option></select></label>
      <label class="field full"><span>RFC <span class="hint">· opcional, para recibos</span></span><input name="rfc" maxlength="13"></label></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', primary: true }],
    onSubmit: async f => { await capi('/personas', { method: 'POST', body: { nombre: val(f, 'nombre'), email: val(f, 'email') || null, telefono: val(f, 'tel') || null, rfc: val(f, 'rfc') || null, unidad_id: +f.unidad.value, rol: f.rol.value } }); invalidar(); toast('Residente agregado.'); ctx.recargar(); },
  });
}

async function detalle(el, ctx, id) {
  cargando(el);
  const desde = `${addMonths(periodoActual(), -11)}-01`;
  const [d, ec, cargos, us] = await Promise.all([capi(`/unidades/${id}`), capi(`/estado-cuenta/${id}?desde=${desde}&hasta=${hoy()}`), capi(`/cargos?unidad=${id}`), capi('/unidades')]);
  const u = d.unidad, c = d.cartera;
  const st = estadoUnidad(c);
  const abiertos = cargos.filter(x => !x.cancelado_at && x.saldo_cents > 0);
  mount(el, html`
    <div class="title-row"><div><p class="crumbs"><a href="#/c/${S.cid}/unidades">Unidades</a> / ${u.torre || ''}</p>
      <h1>Unidad ${u.clave}</h1>
      <p class="sub">${d.personas.filter(p => p.rol === 'propietario').map(p => p.nombre).join(', ') || 'Sin propietario registrado'} · referencia <b class="num">${u.referencia}</b> · cuota ${pesos(u.cuota_cents)} · indiviso ${(u.indiviso_ppm / 10000).toFixed(4)}%</p></div>
      <div class="actions">
        <button class="btn" data-action="estado">Estado de cuenta</button>
        <button class="btn" data-action="constancia">${c.adeudo > 0 ? 'Constancia de adeudo' : 'Carta de no adeudo'}</button>
        ${puede('config') ? html`<button class="btn" data-action="editar">Editar</button>` : ''}
        ${puede('capturar') ? html`<button class="btn primary" data-action="pago">Registrar pago</button>` : ''}</div></div>
    <div class="grid top">
      <section class="panel c4">
        <header><h2>Saldo</h2>${pill(ESTADO_TXT[st])}</header>
        <div class="kpi"><p class="label">${c.saldo_neto >= 0 ? 'Adeudo total' : 'Saldo a favor'}</p><p class="kpi-value ${c.saldo_neto > 0 ? 'neg-t' : c.saldo_neto < 0 ? 'pos-t' : 'zero'}">${pesos(Math.abs(c.saldo_neto))}</p>
          <p class="sub">${c.vencido ? html`<b>${pesos(c.vencido)}</b> vencido · ${c.dias_max} días` : 'Sin saldo vencido'}${c.recargos ? ` · ${pesos(c.recargos)} de recargos` : ''}</p></div>
        <ul class="rows top-gap">
          <li><span class="t">Último pago</span><span class="v">${c.ultimo_pago ? fecha(c.ultimo_pago) : '—'}</span></li>
          <li><span class="t">Ocupación</span><span class="v">${EST[u.estado]}</span></li>
          ${d.convenio ? html`<li><span class="t">Convenio vigente desde</span><span class="v">${fecha(d.convenio.fecha)}<span>${d.convenio.parcialidades} parcialidades · ${pesos(d.convenio.monto_cents)}</span></span></li>` : ''}
        </ul>
        <h3 class="top-gap">Personas</h3>
        <ul class="rows">${d.personas.map(p => html`<li><span class="t"><b>${p.nombre}</b><span>${p.rol}${p.email ? ` · ${p.email}` : ''}${p.telefono ? ` · ${p.telefono}` : ''}</span></span>${puede('capturar') ? html`<button class="link neg" data-action="desvincular" data-vid="${p.vinculo_id}">Quitar</button>` : ''}</li>`)}</ul>
        ${puede('capturar') ? html`<button class="link top-gap" data-action="persona">Agregar persona</button>` : ''}
      </section>
      <div class="stack c8">
        <section class="panel flush"><header><h2>Cargos pendientes</h2><span class="meta">Se pagan del más antiguo al más reciente</span></header>
          ${tabla([
            { t: 'Concepto', k: x => html`${x.concepto}<span class="sub-t">${x.tipo}</span>` }, { t: 'Vence', k: x => fecha(x.vencimiento), cls: 'nowrap' },
            { t: 'Importe', num: true, k: x => m(x.monto_cents) }, { t: 'Saldo', num: true, k: x => m(x.saldo_cents) },
            { t: '', k: x => puede('cancelar') ? html`<span class="row-actions"><button class="link" data-action="bonificar" data-id="${x.id}" data-saldo="${x.saldo_cents}" data-concepto="${x.concepto}">Bonificar</button>${x.saldo_cents === x.monto_cents ? html`<button class="link neg" data-action="cancelarCargo" data-id="${x.id}" data-concepto="${x.concepto}">Cancelar</button>` : ''}</span>` : '' },
          ], abiertos, { vacio: 'La unidad no tiene cargos pendientes.', pie: abiertos.length ? ['Total', '', '', pesos(abiertos.reduce((a, x) => a + x.saldo_cents, 0)), ''] : null })}</section>
        <section class="panel flush"><header><h2>Movimientos de los últimos 12 meses</h2><span class="meta">Saldo inicial ${pesos(ec.saldo_inicial)}</span></header>
          ${tabla([
            { t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' }, { t: 'Concepto', k: r => html`${r.concepto}${r.recibo ? html` · <button class="link" data-action="recibo" data-folio="${r.recibo}">R-${r.recibo}</button>` : ''}` },
            { t: 'Cargo', num: true, k: r => r.cargo ? pesos(r.cargo) : '' }, { t: 'Abono', num: true, k: r => r.abono ? pesos(r.abono) : '' }, { t: 'Saldo', num: true, k: r => pesos(r.saldo) },
          ], [...ec.movimientos].reverse(), { vacio: 'Sin movimientos en el periodo.' })}</section>
        <section class="panel flush"><header><h2>Pagos</h2></header>
          ${tabla([{ t: 'Recibo', k: p => p.folio ? `R-${p.folio}` : '—' }, { t: 'Fecha', k: p => fecha(p.fecha) }, { t: 'Método', k: p => METODOS[p.metodo] }, { t: 'Importe', num: true, k: p => m(p.monto_cents) }, { t: 'Estado', k: p => html`${pill(ESTADO_PAGO[p.estado])}${p.motivo ? html`<span class="sub-t">${p.motivo}</span>` : ''}` }], d.pagos, { vacio: 'Sin pagos registrados.' })}</section>
        <section class="panel"><header><h2>Gestiones de cobranza</h2></header>
          <ul class="rows">${d.gestiones.length ? d.gestiones.map(g => html`<li><span class="t"><b>${g.tipo.replace('_', ' ')}</b><span>${g.nota}${g.promesa_fecha ? ` · promete ${pesos(g.promesa_cents || 0)} el ${fecha(g.promesa_fecha)}` : ''}</span></span><span class="v small">${fechaHora(g.created_at)}<span>${g.autor || ''}</span></span></li>`) : html`<li class="empty-state">Sin gestiones registradas.</li>`}</ul></section>
      </div></div>`);
  const pagoPorFolio = f => d.pagos.find(p => String(p.folio) === String(f));
  ctx.acciones({
    pago: () => dialogoPago({ unidad: u.id, onOk: () => ctx.recargar() }),
    editar: () => editarUnidad(u, ctx),
    persona: () => nuevaPersona(us, u.id, ctx),
    constancia: () => imprimirConstancia(u.id),
    estado: async () => imprimir(docEstadoCuenta(await capi(`/estado-cuenta/${u.id}?desde=${desde}&hasta=${hoy()}`))),
    recibo: async dd => { const p = pagoPorFolio(dd.folio) || (await capi(`/pagos?unidad=${u.id}`)).find(x => String(x.folio) === dd.folio); if (p) imprimirRecibo(p.id); },
    desvincular: async dd => { await capi(`/unidades/${u.id}/personas/${dd.vid}`, { method: 'DELETE' }); invalidar(); ctx.recargar(); },
    bonificar: dd => dialogo({
      titulo: 'Bonificar o condonar', cuerpo: html`<p class="lead">${dd.concepto} · saldo ${pesos(+dd.saldo)}</p>
        <label class="field"><span>Importe a bonificar</span><input name="monto" class="num-in" value="${centsToInput(+dd.saldo)}" required></label>
        <label class="field"><span>Motivo (queda en la bitácora y en la póliza)</span><input name="motivo" required maxlength="200"></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Bonificar', primary: true }],
      onSubmit: async f => { if (!val(f, 'motivo')) throw new Error('Indique el motivo.'); await capi(`/cargos/${dd.id}/bonificar`, { method: 'POST', body: { monto_cents: pesosDe(f, 'monto'), motivo: val(f, 'motivo') } }); invalidar(); toast('Bonificación registrada.'); ctx.recargar(); },
    }),
    cancelarCargo: async dd => { const motivo = await pedirMotivo('Cancelar cargo', `«${dd.concepto}» se cancelará con una contrapóliza.`, 'Cancelar cargo'); if (!motivo) return; await capi(`/cargos/${dd.id}/cancelar`, { method: 'POST', body: { motivo } }); invalidar(); toast('Cargo cancelado.'); ctx.recargar(); },
  });
}
