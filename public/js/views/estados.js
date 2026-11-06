// Estados de cuenta: individual en pantalla y emisión masiva para impresión.
import { capi, html, raw, mount, $, hoy, periodoActual, cargando, imprimir, toast } from '../ui.js';
import { unidades, docEstadoCuenta } from './comun.js';

export async function render(el, ctx) {
  const [, qs] = (ctx.params[0] || '').split('?');
  const q = new URLSearchParams(qs || '');
  const us = (await unidades()).filter(u => u.activo);
  const uid = +(q.get('u') || us[0]?.id);
  const hasta = q.get('hasta') || hoy();
  const desde = q.get('desde') || `${periodoActual()}-01`;
  cargando(el);
  const d = await capi(`/estado-cuenta/${uid}?desde=${desde}&hasta=${hasta}`);
  mount(el, html`
    <div class="title-row"><div><h1>Estados de cuenta</h1><p class="sub">Calculados directamente del libro contable: siempre cuadran con la contabilidad.</p></div>
      <div class="actions"><button class="btn" data-action="masivo">Imprimir todas las unidades</button><button class="btn primary" data-action="imprimir">Imprimir</button></div></div>
    <form class="filters" data-f>
      <label class="field"><span>Unidad</span><select name="u">${us.map(u => html`<option value="${u.id}" ${u.id === uid ? raw('selected') : ''}>${u.clave} · ${u.propietario || ''}</option>`)}</select></label>
      <label class="field"><span>Desde</span><input type="date" name="desde" value="${desde}"></label>
      <label class="field"><span>Hasta</span><input type="date" name="hasta" value="${hasta}" max="${hoy()}"></label>
      <button class="btn">Ver</button></form>
    ${docEstadoCuenta(d)}`);
  $('[data-f]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/?u=${f.u.value}&desde=${f.desde.value}&hasta=${f.hasta.value}`; });
  ctx.acciones({
    imprimir: () => imprimir(docEstadoCuenta(d)),
    masivo: async () => {
      toast('Preparando estados de cuenta…');
      const all = await capi(`/estados-cuenta?desde=${desde}&hasta=${hasta}`);
      const bancos = d.bancos;
      imprimir(html`${all.unidades.map(x => docEstadoCuenta({ ...x, condominio: all.condominio, desde: all.desde, hasta: all.hasta, bancos }))}`);
    },
  });
}
