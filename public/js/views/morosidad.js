// Morosidad: antigüedad de saldos por unidad, gestiones de cobranza y constancias.
import { S, capi, html, raw, mount, $, pesos, fecha, hoy, puede, tabla, m, pill, toast, dialogo, val, pesosDe, descargar, cargando, pct, ICON } from '../ui.js';
import { imprimirConstancia, invalidar } from './comun.js';
import { barraAntiguedad } from './tablero.js';

const GESTION = { llamada: 'Llamada', correo: 'Correo', whatsapp: 'WhatsApp', visita: 'Visita', carta: 'Carta de cobranza', promesa: 'Promesa de pago', aviso_legal: 'Aviso de acción legal' };

export async function render(el, ctx) {
  const [, qs] = (ctx.params[0] || '').split('?');
  const q = new URLSearchParams(qs || '');
  const corte = q.get('corte') || hoy();
  const solo = q.get('todas') !== '1';
  cargando(el);
  const d = await capi(`/morosidad?corte=${corte}`);
  const r = d.resumen;
  const rows = d.unidades.filter(u => u.activo && (!solo || u.vencido > 0)).sort((a, b) => b.vencido - a.vencido || a.clave.localeCompare(b.clave));
  const total = r.vencido;
  mount(el, html`
    <div class="title-row"><div><h1>Morosidad</h1>
      <p class="sub"><b>${r.morosas}</b> de ${r.unidades} unidades (${pct(r.pct_morosidad)}) tienen saldo vencido por <b>${pesos(total)}</b> al ${fecha(corte)}${r.d90mas ? html`; <b>${pesos(r.d90mas)}</b> supera los 90 días` : ''}.</p></div>
      <div class="actions"><button class="btn ghost" data-action="csv">Exportar CSV</button><button class="btn" data-action="avisos">${raw(ICON.pdf)}<span>Avisos de cobro</span></button><button class="btn" data-action="pdfCxc">${raw(ICON.pdf)}<span>Cuentas por cobrar</span></button><button class="btn primary" data-action="pdfMor">${raw(ICON.pdf)}<span>Reporte de morosidad</span></button></div></div>
    <section class="panel">
      <div class="kpis">
        ${[['Por vencer', r.por_vencer], ['1 a 30 días', r.d30], ['31 a 60 días', r.d60], ['61 a 90 días', r.d90], ['Más de 90 días', r.d90mas]].map(([l, v], i) => html`<div class="kpi"><p class="label"><span class="sw b${i}"></span>${l}</p><p class="kpi-value md ${v ? '' : 'zero'}">${pesos(v)}</p></div>`)}
      </div>
      <div class="top-gap">${barraAntiguedad(r)}</div>
    </section>
    ${r.morosas ? html`<section class="panel top-gap"><header><h2>Mayor adeudo vencido</h2><span class="meta">Las 8 unidades con más saldo vencido</span></header><div id="ch-mor"></div></section>` : ''}
    <form class="filters top-gap" data-filtros>
      <label class="field"><span>Fecha de corte</span><input type="date" name="corte" value="${corte}" max="${hoy()}"></label>
      <label class="check"><input type="checkbox" name="todas" ${solo ? '' : raw('checked')}><span>Incluir unidades al corriente</span></label>
      <button class="btn">Aplicar</button>
    </form>
    <section class="panel flush">
      <header><h2>${rows.length} unidades</h2><span class="meta">Ordenadas por saldo vencido</span></header>
      ${tabla([
        { t: 'Unidad', k: u => html`<a class="link" href="#/c/${S.cid}/unidades/${u.id}">${u.clave}</a><span class="sub-t">${u.propietario || '—'}</span>` },
        { t: 'Por vencer', num: true, k: u => m(u.por_vencer), cls: 'hide-m' },
        { t: '1–30', num: true, k: u => m(u.d30), cls: 'hide-m' },
        { t: '31–60', num: true, k: u => m(u.d60), cls: 'hide-m' },
        { t: '61–90', num: true, k: u => m(u.d90), cls: 'hide-m' },
        { t: '90+', num: true, k: u => m(u.d90mas), cls: 'hide-m' },
        { t: 'Vencido', num: true, k: u => html`<b>${m(u.vencido)}</b><span class="sub-t">${u.meses ? `${u.meses} ${u.meses === 1 ? 'cuota' : 'cuotas'}` : ''}${u.recargos ? ` · ${pesos(u.recargos)} recargos` : ''}</span>` },
        { t: 'Último pago', k: u => u.ultimo_pago ? fecha(u.ultimo_pago) : html`<span class="faint">—</span>`, cls: 'nowrap hide-m' },
        { t: '', k: u => html`${u.convenio ? html`${pill(u.convenio.al_corriente ? ['Convenio al corriente', 'pos'] : ['Convenio atrasado', 'neg'])} ` : ''}<span class="row-actions">
          ${puede('capturar') ? html`<button class="link" data-action="gestion" data-id="${u.id}" data-clave="${u.clave}">Gestión</button>` : ''}
          <button class="link" data-action="constancia" data-id="${u.id}">Constancia</button>
          ${u.telefono ? html`<a class="link" href="${'https://wa.me/52' + u.telefono.replace(/\D/g, '') + '?text=' + encodeURIComponent(`Estimado(a) condómino de la unidad ${u.clave}: le recordamos que su saldo vencido es de ${pesos(u.vencido)}. Referencia de pago: ${u.referencia}.`)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ''}</span>` },
      ], rows, { vacio: 'Ninguna unidad tiene saldo vencido a la fecha de corte.', pie: ['Total', pesos(rows.reduce((a, u) => a + u.por_vencer, 0)), pesos(rows.reduce((a, u) => a + u.d30, 0)), pesos(rows.reduce((a, u) => a + u.d60, 0)), pesos(rows.reduce((a, u) => a + u.d90, 0)), pesos(rows.reduce((a, u) => a + u.d90mas, 0)), pesos(rows.reduce((a, u) => a + u.vencido, 0)), '', ''] })}
    </section>`);
  $('[data-filtros]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/?corte=${f.corte.value}&todas=${f.todas.checked ? 1 : 0}`; });
  const top = d.unidades.filter(u => u.activo && u.vencido > 0).sort((a, b) => b.vencido - a.vencido).slice(0, 8);
  if (top.length) window.Charts?.barList($('#ch-mor', el), top.map(u => ({ label: `${u.clave} · ${u.propietario || ''}`, value: u.vencido / 100 })), { format: v => '$' + Math.round(v).toLocaleString('es-MX') });
  const pdf = async fn => { toast('Generando PDF…'); const [c, I] = await Promise.all([capi('/config'), import('../informes.js')]); await I[fn](d, c); };
  ctx.acciones({
    pdfCxc: () => pdf('pdfCxc'), pdfMor: () => pdf('pdfMorosidad'),
    avisos: async () => { toast('Preparando avisos de cobro…'); const all = await capi(`/estados-cuenta?desde=${corte.slice(0, 4)}-01-01&hasta=${corte}`); await (await import('../informes.js')).pdfAvisos(all.unidades.filter(x => x.pendientes.some(p => p.vencimiento < corte)), { condominio: all.condominio, bancos: all.bancos, fecha: corte }); },
    csv: () => descargar(`/api/c/${S.cid}/export/cartera.csv`, 'cartera.csv'),
    constancia: dd => imprimirConstancia(dd.id),
    gestion: dd => dialogo({
      titulo: `Gestión de cobranza · ${dd.clave}`,
      cuerpo: html`<div class="form-grid">
        <label class="field"><span>Tipo</span><select name="tipo">${Object.entries(GESTION).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label class="field"><span>Fecha prometida</span><input name="pf" type="date" min="${hoy()}"></label>
        <label class="field full"><span>Nota</span><textarea name="nota" rows="3" maxlength="500" required></textarea></label>
        <label class="field"><span>Importe prometido</span><input name="pc" class="num-in" inputmode="decimal"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar gestión', primary: true }],
      onSubmit: async f => {
        if (!val(f, 'nota')) throw new Error('Escriba una nota.');
        await capi('/gestiones', { method: 'POST', body: { unidad_id: +dd.id, tipo: f.tipo.value, nota: val(f, 'nota'), promesa_fecha: val(f, 'pf') || null, promesa_cents: val(f, 'pc') ? pesosDe(f, 'pc') : null } });
        invalidar(); toast('Gestión registrada en el expediente de la unidad.');
      },
    }),
  });
}
