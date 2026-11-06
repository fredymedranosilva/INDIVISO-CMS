// Contabilidad: pólizas (libro diario), catálogo, libro mayor y balanza de comprobación.
import { S, capi, html, raw, mount, $, $$, pesos, fecha, fechaHora, mesNombre, periodoActual, addMonths, hoy, puede, tabla, m, pill, toast, dialogo, val, cargando, tabs, parsePesos, descargar } from '../ui.js';
import { pedirMotivo } from './comun.js';

const TIPO = { I: 'Ingreso', E: 'Egreso', D: 'Diario' };
const ORIGEN = { emision: 'Emisión de cuotas', extraordinaria: 'Cuota extraordinaria', recargos: 'Recargos', cargo: 'Cargo individual', pago: 'Cobro', aplicacion_anticipo: 'Aplicación de saldo a favor', bonificacion: 'Bonificación',
  cancelacion_cargo: 'Cancelación de cargo', cancelacion_pago: 'Cancelación de cobro', egreso: 'Provisión de egreso', pago_egreso: 'Pago a proveedor', cancelacion_egreso: 'Cancelación de egreso', manual: 'Manual', reverso: 'Reversa', cierre_ejercicio: 'Cierre de ejercicio' };

export async function render(el, ctx) {
  const [sub, qs] = (ctx.params[0] || 'polizas').split('?');
  const q = new URLSearchParams(qs || '');
  mount(el, html`<div class="title-row"><div><h1>Contabilidad</h1><p class="sub">Partida doble. Lo contabilizado no se edita ni se borra: se corrige con una contrapóliza que queda ligada a la original.</p></div>
    <div class="actions"><button class="btn ghost" data-action="csv">Exportar pólizas CSV</button>${puede('capturar') ? html`<button class="btn primary" data-action="manual">Póliza manual</button>` : ''}</div></div>
    ${tabs([['polizas', 'Pólizas'], ['mayor', 'Libro mayor'], ['balanza', 'Balanza de comprobación'], ['catalogo', 'Catálogo de cuentas']], sub.split('/')[0], ctx.base)}<div id="ct-body"></div>`);
  const body = $('#ct-body', el);
  cargando(body);
  const cuentas = await capi('/cuentas');
  ctx.acciones({ manual: () => polizaManual(cuentas, ctx), csv: () => descargar(`/api/c/${S.cid}/export/polizas.csv`, 'polizas.csv') });
  if (sub === 'polizas' && ctx.params[1]) return detalle(body, ctx, +ctx.params[1]);
  if (sub === 'mayor') return mayor(body, ctx, cuentas, q);
  if (sub === 'balanza') return balanza(body, ctx, q);
  if (sub === 'catalogo') return catalogo(body, ctx, cuentas);
  return polizas(body, ctx, q);
}

async function polizas(el, ctx, q) {
  const periodo = q.get('periodo') || periodoActual(), tipo = q.get('tipo') || '', texto = q.get('q') || '';
  const rows = await capi(`/polizas?periodo=${periodo}${tipo ? `&tipo=${tipo}` : ''}${texto ? `&q=${encodeURIComponent(texto)}` : ''}`);
  const ps = Array.from({ length: 14 }, (_, i) => addMonths(periodoActual(), -i));
  mount(el, html`<form class="filters" data-f>
      <label class="field"><span>Periodo</span><select name="periodo">${ps.map(p => html`<option value="${p}" ${p === periodo ? raw('selected') : ''}>${mesNombre(p)}</option>`)}</select></label>
      <label class="field"><span>Tipo</span><select name="tipo"><option value="">Todas</option>${Object.entries(TIPO).map(([k, l]) => html`<option value="${k}" ${k === tipo ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="field search-f"><span>Concepto</span><input name="q" value="${texto}"></label><button class="btn">Filtrar</button></form>
    <section class="panel flush"><header><h2>${rows.length} pólizas · ${mesNombre(periodo)}</h2><span class="meta">Total ${pesos(rows.reduce((a, r) => a + r.total_cents, 0))}</span></header>
    ${tabla([
      { t: 'Póliza', k: r => html`<b>${r.tipo}-${r.folio}</b>` }, { t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' },
      { t: 'Concepto', k: r => html`${r.concepto}<span class="sub-t">${ORIGEN[r.origen] || r.origen}${r.reversa_de ? ' · contrapóliza' : ''}</span>` },
      { t: 'Importe', num: true, k: r => m(r.total_cents) }, { t: '', k: r => r.reversada_por ? pill(['Revertida', 'neutral']) : '' },
    ], rows, { fila: r => `data-href="#/c/${S.cid}/contabilidad/polizas/${r.id}" tabindex="0"`, vacio: 'Sin pólizas en el periodo.' })}</section>`);
  $('[data-f]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/polizas?periodo=${f.periodo.value}&tipo=${f.tipo.value}&q=${encodeURIComponent(f.q.value)}`; });
}

async function detalle(el, ctx, id) {
  const { poliza: p, movimientos } = await capi(`/polizas/${id}`);
  const d = movimientos.reduce((a, x) => a + x.debe_cents, 0), h = movimientos.reduce((a, x) => a + x.haber_cents, 0);
  mount(el, html`<section class="panel">
    <header><div><p class="crumbs"><a href="${ctx.base}/polizas?periodo=${p.periodo}">Pólizas de ${mesNombre(p.periodo)}</a></p><h2>Póliza ${TIPO[p.tipo].toLowerCase()} ${p.tipo}-${p.folio}</h2></div>
      <div class="actions">${p.reversada_por ? html`<a class="link" href="${ctx.base}/polizas/${p.reversada_por}">Ver contrapóliza</a>` : ''}${p.reversa_de ? html`<a class="link" href="${ctx.base}/polizas/${p.reversa_de}">Ver póliza original</a>` : ''}
        ${p.origen === 'manual' && !p.reversada_por && puede('cancelar') ? html`<button class="btn" data-action="revertir">Revertir</button>` : ''}</div></header>
    <div class="doc-meta"><div><span>Fecha</span><b>${fecha(p.fecha)}</b></div><div><span>Origen</span><b>${ORIGEN[p.origen] || p.origen}</b></div><div><span>Registró</span><b>${p.autor || 'Sistema'}</b></div><div><span>Registrada</span><b>${fechaHora(p.created_at)}</b></div></div>
    <p class="lead">${p.concepto}</p>
    <div class="top-gap">${tabla([
      { t: 'Cuenta', k: x => html`${x.codigo} · ${x.cuenta}${x.unidad ? html`<span class="sub-t">Unidad ${x.unidad}</span>` : ''}` }, { t: 'Concepto', k: x => x.concepto || '', cls: 'hide-m' },
      { t: 'Debe', num: true, k: x => x.debe_cents ? pesos(x.debe_cents) : '' }, { t: 'Haber', num: true, k: x => x.haber_cents ? pesos(x.haber_cents) : '' },
    ], movimientos, { pie: ['Sumas iguales', '', pesos(d), pesos(h)] })}</div>
    <p class="meta top-gap">${d === h ? '✓ Póliza cuadrada.' : 'La póliza no cuadra.'}</p></section>`);
  ctx.acciones({
    revertir: async () => { const motivo = await pedirMotivo(`Revertir ${p.tipo}-${p.folio}`, 'Se registrará una contrapóliza con fecha de hoy que anula sus efectos.', 'Revertir'); if (!motivo) return; const r = await capi(`/polizas/${p.id}/revertir`, { method: 'POST', body: { motivo } }); toast('Póliza revertida.'); location.hash = `${ctx.base}/polizas/${r.id}`; },
  });
}

function polizaManual(cuentas, ctx) {
  const usables = cuentas.filter(k => k.activo && !['CXC', 'ANTICIPOS'].includes(k.clave));
  const opts = html`${usables.map(k => html`<option value="${k.id}">${k.codigo} · ${k.nombre}</option>`)}`;
  const linea = () => html`<tr><td><select name="cta" aria-label="Cuenta">${opts}</select></td><td><input name="concepto" maxlength="120" aria-label="Concepto"></td><td><input class="cell" name="debe" inputmode="decimal" aria-label="Debe"></td><td><input class="cell" name="haber" inputmode="decimal" aria-label="Haber"></td></tr>`;
  dialogo({
    titulo: 'Póliza manual', ancho: 'wide',
    cuerpo: html`<div class="form-grid"><label class="field"><span>Tipo</span><select name="tipo"><option value="D">Diario</option><option value="I">Ingreso</option><option value="E">Egreso</option></select></label>
      <label class="field"><span>Fecha</span><input type="date" name="fecha" value="${hoy()}" required></label>
      <label class="field full"><span>Concepto</span><input name="concepto_p" required maxlength="200"></label></div>
      <div class="table-wrap"><table class="tbl dense"><thead><tr><th>Cuenta</th><th>Concepto</th><th class="r">Debe</th><th class="r">Haber</th></tr></thead><tbody data-lineas>${linea()}${linea()}</tbody>
      <tfoot><tr><td><button type="button" class="link" data-mas>Agregar línea</button></td><td class="r">Sumas</td><td class="r num" data-sd>$0.00</td><td class="r num" data-sh>$0.00</td></tr></tfoot></table></div>
      <p class="note">Las cuentas de condóminos (cuotas por cobrar y anticipos) solo se afectan desde Cobranza, para que los estados de cuenta cuadren siempre con la contabilidad.</p>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar póliza', primary: true }],
    onOpen: (d) => {
      const tb = d.querySelector('[data-lineas]');
      const sumar = () => { let sd = 0, sh = 0; for (const tr of tb.rows) { sd += parsePesos(tr.querySelector('[name=debe]').value) || 0; sh += parsePesos(tr.querySelector('[name=haber]').value) || 0; } d.querySelector('[data-sd]').textContent = pesos(sd); d.querySelector('[data-sh]').textContent = pesos(sh); d.querySelector('[data-sh]').classList.toggle('neg-t', sd !== sh); };
      tb.addEventListener('input', sumar);
      d.querySelector('[data-mas]').addEventListener('click', () => { tb.insertAdjacentHTML('beforeend', linea().s); });
    },
    onSubmit: async (f) => {
      const tb = f.querySelector('[data-lineas]');
      const lineas = [...tb.rows].map(tr => ({ cuenta: +tr.querySelector('[name=cta]').value, concepto: tr.querySelector('[name=concepto]').value.trim() || null, debe: tr.querySelector('[name=debe]').value.trim() ? parsePesos(tr.querySelector('[name=debe]').value) : 0, haber: tr.querySelector('[name=haber]').value.trim() ? parsePesos(tr.querySelector('[name=haber]').value) : 0 }))
        .filter(l => l.debe || l.haber);
      if (lineas.some(l => l.debe == null || l.haber == null || (l.debe && l.haber))) throw new Error('Cada línea lleva un importe en Debe o en Haber, no en ambos.');
      const r = await capi('/polizas', { method: 'POST', body: { tipo: f.tipo.value, fecha: val(f, 'fecha'), concepto: val(f, 'concepto_p'), lineas } });
      toast('Póliza registrada.'); location.hash = `#/c/${S.cid}/contabilidad/polizas/${r.id}`;
    },
  });
}

async function mayor(el, ctx, cuentas, q) {
  const anio = hoy().slice(0, 4);
  const cid = +(q.get('cuenta') || cuentas.find(k => k.clave === 'CXC')?.id);
  const desde = q.get('desde') || `${anio}-01`, hasta = q.get('hasta') || periodoActual();
  const r = await capi(`/reportes/mayor?cuenta=${cid}&desde=${desde}&hasta=${hasta}`);
  mount(el, html`<form class="filters" data-f>
      <label class="field"><span>Cuenta</span><select name="cuenta">${cuentas.map(k => html`<option value="${k.id}" ${k.id === cid ? raw('selected') : ''}>${k.codigo} · ${k.nombre}</option>`)}</select></label>
      <label class="field"><span>Desde</span><input type="month" name="desde" value="${desde}"></label><label class="field"><span>Hasta</span><input type="month" name="hasta" value="${hasta}"></label><button class="btn">Ver</button></form>
    <section class="panel flush"><header><h2>${r.cuenta.codigo} · ${r.cuenta.nombre}</h2><span class="meta">Saldo inicial ${pesos(r.inicial)} · final <b>${pesos(r.final)}</b></span></header>
    ${tabla([
      { t: 'Fecha', k: x => fecha(x.fecha), cls: 'nowrap' }, { t: 'Póliza', k: x => html`<a class="link" href="#/c/${S.cid}/contabilidad/polizas/${x.poliza_id}">${x.tipo}-${x.folio}</a>` },
      { t: 'Concepto', k: x => html`${x.concepto || x.poliza_concepto}${x.unidad ? html`<span class="sub-t">Unidad ${x.unidad}</span>` : ''}` },
      { t: 'Debe', num: true, k: x => x.debe_cents ? pesos(x.debe_cents) : '' }, { t: 'Haber', num: true, k: x => x.haber_cents ? pesos(x.haber_cents) : '' }, { t: 'Saldo', num: true, k: x => pesos(x.saldo) },
    ], r.movimientos.slice(-400), { vacio: 'Sin movimientos en el rango.' })}</section>`);
  $('[data-f]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/mayor?cuenta=${f.cuenta.value}&desde=${f.desde.value}&hasta=${f.hasta.value}`; });
}

async function balanza(el, ctx, q) {
  const desde = q.get('desde') || periodoActual(), hasta = q.get('hasta') || periodoActual();
  const b = await capi(`/reportes/balanza?desde=${desde}&hasta=${hasta}`);
  mount(el, html`<form class="filters" data-f><label class="field"><span>Desde</span><input type="month" name="desde" value="${desde}"></label><label class="field"><span>Hasta</span><input type="month" name="hasta" value="${hasta}"></label><button class="btn">Ver</button></form>
    <section class="panel flush"><header><h2>Balanza de comprobación</h2><span class="meta">${b.cuadra ? '✓ Cargos y abonos cuadran' : 'La balanza no cuadra'}</span></header>
    ${tabla([{ t: 'Cuenta', k: r => html`${r.codigo} · ${r.nombre}` }, { t: 'Saldo inicial', num: true, k: r => m(r.inicial) }, { t: 'Cargos', num: true, k: r => m(r.debe) }, { t: 'Abonos', num: true, k: r => m(r.haber) }, { t: 'Saldo final', num: true, k: r => m(r.final) }],
      b.rows, { pie: ['Sumas', '', pesos(b.totales.debe), pesos(b.totales.haber), ''] })}</section>`);
  $('[data-f]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/balanza?desde=${f.desde.value}&hasta=${f.hasta.value}`; });
}

function catalogo(el, ctx, cuentas) {
  const TIPOS = { activo: 'Activo', pasivo: 'Pasivo', patrimonio: 'Patrimonio', ingreso: 'Ingresos', egreso: 'Egresos' };
  mount(el, html`<div class="filters"><span class="spacer"></span>${puede('config') ? html`<button class="btn" data-action="nueva">Nueva cuenta</button>` : ''}</div>
    <section class="panel flush"><header><h2>Catálogo de cuentas</h2><span class="meta">Las cuentas con clave de sistema alimentan cobranza, fondos y bancos.</span></header>
    <div class="table-wrap"><table class="tbl dense"><thead><tr><th>Código</th><th>Cuenta</th><th>Naturaleza</th><th>Uso</th></tr></thead><tbody>
    ${Object.entries(TIPOS).map(([t, l]) => html`<tr class="grupo"><td colspan="4">${l}</td></tr>${cuentas.filter(k => k.tipo === t).map(k => html`<tr><td class="num">${k.codigo}</td><td>${k.nombre}</td><td>${k.naturaleza === 'D' ? 'Deudora' : 'Acreedora'}</td><td>${k.clave ? html`<span class="pill neutral">${k.clave}</span>` : k.presupuestable ? 'Partida presupuestal' : ''}</td></tr>`)}`)}
    </tbody></table></div></section>`);
  ctx.acciones({
    nueva: () => dialogo({
      titulo: 'Nueva cuenta contable', cuerpo: html`<div class="form-grid"><label class="field"><span>Código</span><input name="codigo" required placeholder="5504" maxlength="12"></label>
        <label class="field"><span>Tipo</span><select name="tipo">${Object.entries(TIPOS).map(([k, l]) => html`<option value="${k}" ${k === 'egreso' ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="field full"><span>Nombre</span><input name="nombre" required maxlength="120"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Crear cuenta', primary: true }],
      onSubmit: async f => { await capi('/cuentas', { method: 'POST', body: { codigo: val(f, 'codigo'), nombre: val(f, 'nombre'), tipo: f.tipo.value } }); toast('Cuenta creada.'); ctx.recargar(); },
    }),
  });
}
