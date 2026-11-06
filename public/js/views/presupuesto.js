// Presupuesto anual versionado: captura por partida y mes, aprobación en asamblea, ejercido y cuota sugerida.
import { capi, html, raw, mount, $, $$, pesos, puede, tabla, m, pill, toast, dialogo, val, cargando, barra, pct, centsToInput, parsePesos, hoy, confirmar, fechaHora } from '../ui.js';
import { invalidar } from './comun.js';
import { abrirImportacion, descargarPlantilla } from './importar.js';

const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const EST = { borrador: ['Borrador', 'warn'], aprobado: ['Aprobado', 'pos'], sustituido: ['Sustituido', 'neutral'] };

export async function render(el, ctx) {
  cargando(el);
  const lista = await capi('/presupuestos');
  const anio = +hoy().slice(0, 4);
  const sel = lista.find(p => p.id === +ctx.params[0]) || lista.find(p => p.ejercicio === anio && p.estado === 'aprobado') || lista[0];
  if (!sel) {
    mount(el, html`<div class="title-row"><div><h1>Presupuesto</h1><p class="sub">Aún no hay presupuestos.</p></div>${puede('capturar') ? html`<button class="btn primary" data-action="nuevo">Crear presupuesto ${anio}</button>` : ''}</div>`);
    return ctx.acciones({ nuevo: () => nuevo(anio, ctx) });
  }
  const d = await capi(`/presupuestos/${sel.id}`);
  const p = d.presupuesto, editable = p.estado === 'borrador' && puede('capturar');
  const val12 = new Map(); for (const l of d.lineas) val12.set(`${l.cuenta_id}:${l.mes}`, l.monto_cents);
  const totalMes = i => d.cuentas.reduce((a, k) => a + (val12.get(`${k.id}:${i + 1}`) || 0), 0);
  const totalCta = k => Array.from({ length: 12 }, (_, i) => val12.get(`${k.id}:${i + 1}`) || 0).reduce((a, b) => a + b, 0);
  const anual = d.cuentas.reduce((a, k) => a + totalCta(k), 0);
  const vs = d.vs, s = d.sugerida;
  const cambios = s.unidades.filter(u => u.cuota_cents !== u.sugerida_cents).length;
  mount(el, html`
    <div class="title-row"><div><h1>Presupuesto ${p.ejercicio}</h1>
      <p class="sub">Versión ${p.version} · ${pill(EST[p.estado])} ${p.estado === 'aprobado' ? html`· ${p.acta || ''} · aprobado ${fechaHora(p.aprobado_at)}` : ''} · gasto anual <b>${pesos(anual)}</b></p></div>
      <div class="actions">
        <label class="switcher-inline"><span class="sr">Versión</span><select data-change="version">${lista.map(x => html`<option value="${x.id}" ${x.id === p.id ? raw('selected') : ''}>${x.ejercicio} · v${x.version} · ${EST[x.estado][0]}</option>`)}</select></label>
        ${puede('capturar') && !lista.some(x => x.ejercicio === p.ejercicio && x.estado === 'borrador') ? html`<button class="btn" data-action="version">Nueva versión</button>` : ''}
        ${puede('capturar') && !lista.some(x => x.ejercicio === anio + 1) ? html`<button class="btn" data-action="siguiente">Presupuesto ${anio + 1}</button>` : ''}
        <button class="btn ghost" data-action="exportar">Exportar a Excel</button>
        ${editable ? html`<button class="btn" data-action="importar">Importar desde Excel</button><button class="btn" data-action="guardar">Guardar cambios</button>` : ''}
        ${p.estado === 'borrador' && puede('config') ? html`<button class="btn primary" data-action="aprobar">Aprobar</button>` : ''}</div></div>

    ${p.estado !== 'borrador' ? html`<div class="grid top">
      <section class="panel c8"><header><h2>Ejercido contra presupuesto</h2><span class="meta">${vs.mes_actual ? `a ${MES[vs.mes_actual - 1].toLowerCase()} ${p.ejercicio}` : ''}</span></header>
        <div class="kpis"><div class="kpi"><p class="label">Presupuesto a la fecha</p><p class="kpi-value md">${pesos(vs.totales.a_la_fecha)}</p></div>
          <div class="kpi"><p class="label">Ejercido</p><p class="kpi-value md">${pesos(vs.totales.ejercido)}</p><p class="sub">${pct(vs.totales.a_la_fecha ? vs.totales.ejercido / vs.totales.a_la_fecha : null)} de lo previsto a la fecha</p></div>
          <div class="kpi"><p class="label">Disponible en el año</p><p class="kpi-value md ${vs.totales.disponible < 0 ? 'neg-t' : ''}">${pesos(vs.totales.disponible)}</p></div></div>
        <div class="top-gap">${tabla([
          { t: 'Partida', k: r => html`${r.nombre}<span class="sub-t">${r.codigo}</span>` },
          { t: 'A la fecha', num: true, k: r => m(r.a_la_fecha) }, { t: 'Ejercido', num: true, k: r => m(r.ejercido) },
          { t: 'Variación', num: true, k: r => html`<span class="num ${r.variacion < 0 ? 'neg-t' : ''}">${pesos(r.variacion, { signo: true })}</span>` },
          { t: 'Avance anual', k: r => html`<div class="hbar"><span></span><span class="num small">${pct(r.anual ? r.ejercido / r.anual : null, 0)}</span>${barra(r.anual ? r.ejercido / r.anual : 1, { cls: r.ejercido > r.anual ? 'neg' : r.ejercido > r.a_la_fecha ? 'warn' : '' })}</div>`, cls: 'hide-m' },
        ], vs.rows)}</div></section>
      <section class="panel c4"><header><h2>Cuota que cubre el presupuesto</h2></header>
        <div class="kpi"><p class="label">Recaudación mensual necesaria</p><p class="kpi-value">${pesos(s.mensual_requerido)}</p><p class="sub">gasto mensual promedio ${pesos(Math.round(s.anual_egresos / 12))} más la aportación al fondo de reserva, prorrateada por indiviso</p></div>
        <ul class="rows top-gap">${s.unidades.slice(0, 6).map(u => html`<li><span class="t">${u.clave}</span><span class="v">${pesos(u.sugerida_cents)}<span>hoy ${pesos(u.cuota_cents)}</span></span></li>`)}</ul>
        <p class="meta top-gap">${cambios ? `${cambios} de ${s.unidades.length} unidades cambiarían de cuota.` : 'Las cuotas actuales ya cubren este presupuesto.'}</p>
        ${p.estado === 'aprobado' && puede('config') && cambios ? html`<button class="btn top-gap" data-action="aplicar">Actualizar cuotas de las unidades</button>` : ''}</section></div>` : ''}

    <section class="panel flush top-gap"><header><h2>Partidas por mes</h2><span class="meta">${editable ? 'Escriba los importes en pesos; al guardar se valida cada línea.' : 'Para modificar un presupuesto aprobado cree una nueva versión; la anterior se conserva.'}</span></header>
      <div class="table-wrap"><table class="tbl grid-pres dense">
        <thead><tr><th>Partida</th>${MES.map(x => html`<th class="r">${x}</th>`)}<th class="r">Anual</th></tr></thead>
        <tbody>${d.cuentas.map(k => html`<tr><td>${k.codigo} · ${k.nombre}</td>${MES.map((_, i) => { const v = val12.get(`${k.id}:${i + 1}`) || 0;
          return html`<td class="r num">${editable ? html`<input class="cell" data-c="${k.id}" data-m="${i + 1}" value="${v ? centsToInput(v) : ''}" inputmode="decimal" aria-label="${k.nombre} ${MES[i]}">` : html`<span class="${v ? '' : 'zero'}">${v ? pesos(v).replace('.00', '') : '0'}</span>`}</td>`; })}<td class="r num"><b>${pesos(totalCta(k))}</b></td></tr>`)}</tbody>
        <tfoot><tr><td>Total</td>${MES.map((_, i) => html`<td class="r num">${pesos(totalMes(i)).replace('.00', '')}</td>`)}<td class="r num">${pesos(anual)}</td></tr></tfoot>
      </table></div></section>`);

  ctx.acciones({
    version: async (_, elx) => { if (elx.tagName === 'SELECT') { location.hash = `${ctx.base}/${elx.value}`; return; } const r = await capi('/presupuestos', { method: 'POST', body: { ejercicio: p.ejercicio } }); toast('Borrador creado a partir de la versión aprobada.'); location.hash = `${ctx.base}/${r.id}`; },
    siguiente: () => nuevo(anio + 1, ctx),
    exportar: () => descargarPlantilla('presupuesto', { valores: val12 }),
    importar: () => abrirImportacion('presupuesto', { opciones: { presupuesto_id: p.id }, extra: { valores: val12 }, onOk: () => ctx.recargar() }),
    guardar: async () => {
      const lineas = $$('input.cell', el).map(i => { const c = i.value.trim() ? parsePesos(i.value) : 0; if (c == null) { i.focus(); throw new Error(`Importe inválido en ${i.getAttribute('aria-label')}.`); } return { cuenta_id: +i.dataset.c, mes: +i.dataset.m, monto_cents: c }; });
      await capi(`/presupuestos/${p.id}/lineas`, { method: 'PUT', body: { lineas } }); toast('Presupuesto guardado.'); ctx.recargar();
    },
    aprobar: () => dialogo({
      titulo: `Aprobar presupuesto ${p.ejercicio}`, cuerpo: html`<p class="lead">Un presupuesto aprobado ya no se modifica. La versión aprobada anterior quedará como sustituida.</p><label class="field"><span>Acta de asamblea que lo aprueba</span><input name="acta" required maxlength="200" placeholder="Asamblea ordinaria del 06/12/2026, acta 15"></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Aprobar presupuesto', primary: true }],
      onSubmit: async f => { if (!val(f, 'acta')) throw new Error('Indique el acta.'); await capi(`/presupuestos/${p.id}/aprobar`, { method: 'POST', body: { acta: val(f, 'acta') } }); toast('Presupuesto aprobado.'); ctx.recargar(); },
    }),
    aplicar: async () => { if (!await confirmar('Actualizar cuotas', `Se actualizará la cuota ordinaria de ${cambios} unidades según su indiviso. Aplica desde la próxima emisión.`, { label: 'Actualizar cuotas' })) return; await capi(`/presupuestos/${p.id}/aplicar-cuotas`, { method: 'POST', body: {} }); invalidar(); toast('Cuotas actualizadas.'); ctx.recargar(); },
  });
}

async function nuevo(ejercicio, ctx) {
  const r = await capi('/presupuestos', { method: 'POST', body: { ejercicio } });
  toast(`Borrador ${ejercicio} creado.`); location.hash = `${ctx.base}/${r.id}`;
}
