// Ingresos: todo lo cobrado, mes con mes, clasificado por lo que se pagó (ordinario, extraordinario, pendiente de aplicar).
import { html, mount, $, cargando } from '../ui.js';
import { ingresosVista } from './finrep.js';

export async function render(el, ctx) {
  const [, qs] = (ctx.params[0] || '').split('?');
  mount(el, html`<div class="title-row"><div><h1>Ingresos</h1><p class="sub">Todo lo cobrado mes con mes, por clasificación y concepto. Elija el mes y el año, o «Todo el año».</p></div></div><div id="ing-body"></div>`);
  const body = $('#ing-body', el);
  cargando(body);
  await ingresosVista(body, ctx, new URLSearchParams(qs || ''), `${ctx.base}/`);
}
