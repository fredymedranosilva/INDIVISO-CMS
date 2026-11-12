// Cierres: bloqueo de periodos (con respaldo previo), cierre de ejercicio y verificación de integridad.
import { S, capi, html, raw, mount, pesos, fechaHora, mesNombre, periodoActual, hoy, puede, tabla, pill, toast, confirmar, cargando, ICON } from '../ui.js';
import { pedirMotivo } from './comun.js';

export async function render(el, ctx) {
  cargando(el);
  const [ps, integ] = await Promise.all([capi('/periodos'), capi('/integridad')]);
  const abiertos = ps.filter(p => p.estado === 'abierto').map(p => p.periodo).sort();
  const siguiente = abiertos.find(p => p < periodoActual());
  const ck = siguiente ? await capi(`/periodos/${siguiente}/checklist`) : null;
  const ultimoCerrado = ps.filter(p => p.estado === 'cerrado').map(p => p.periodo).sort().at(-1);
  const anioAnt = +hoy().slice(0, 4) - 1;
  const bloquea = ck && (ck.pagos_por_validar || ck.egresos_por_aprobar || ck.anteriores_abiertos);
  mount(el, html`
    <div class="title-row"><div><h1>Cierres contables</h1><p class="sub">Un mes cerrado queda bloqueado en la base de datos: ningún usuario, ni siquiera el administrador, puede registrar movimientos con esa fecha. Antes de cada cierre se genera un respaldo cifrado.</p></div></div>
    <div class="grid top">
      <section class="panel c7"><header><h2>${siguiente ? `Cerrar ${mesNombre(siguiente)}` : 'No hay meses pendientes de cierre'}</h2></header>
        ${ck ? html`<ul class="rows">
          ${item(!ck.egresos_por_aprobar, 'Egresos aprobados o rechazados', ck.egresos_por_aprobar ? `${ck.egresos_por_aprobar} pendientes` : 'listo', `#/c/${S.cid}/egresos/aprobar`)}
          ${item(ck.cuotas_emitidas > 0, 'Cuotas del mes emitidas', ck.cuotas_emitidas ? `${ck.cuotas_emitidas} cuotas` : 'sin emitir', `#/c/${S.cid}/cobranza/emision`, true)}
          ${item(!ck.movs_sin_conciliar, 'Movimientos bancarios conciliados', ck.movs_sin_conciliar ? `${ck.movs_sin_conciliar} sin conciliar` : 'listo', `#/c/${S.cid}/bancos`, true)}
        </ul>
        <p class="meta top-gap">Los dos primeros puntos son obligatorios; los demás se recomiendan.</p>
        ${puede('cerrar') ? html`<button class="btn primary top-gap" data-action="cerrar" data-p="${siguiente}" ${bloquea ? raw('disabled') : ''}>${raw(ICON.candado)} Cerrar ${mesNombre(siguiente)}</button>` : ''}`
        : html`<p class="lead">Todos los meses anteriores al actual están cerrados.</p>`}
      </section>
      <section class="panel c5"><header><h2>Integridad de la información</h2>${pill(integ.ok ? ['Verificada', 'pos'] : ['Revisar', 'neg'])}</header>
        <ul class="rows">
          <li><span class="t">Pólizas cuadradas (debe = haber)</span><span class="v">${integ.polizas_descuadradas.length ? html`<b class="neg-t">${integ.polizas_descuadradas.length} descuadradas</b>` : '✓'}</span></li>
          <li><span class="t">Balance general cuadra</span><span class="v">${integ.balance_cuadra ? '✓' : html`<b class="neg-t">no</b>`}</span></li>
          <li><span class="t"><b>Cuotas por cobrar</b><span>libro ${pesos(integ.cxc.libro)} · estados de cuenta ${pesos(integ.cxc.submayor)}</span></span><span class="v">${integ.cxc.cuadra ? '✓' : html`<b class="neg-t">difiere</b>`}</span></li>
          <li><span class="t"><b>Saldos a favor</b><span>libro ${pesos(integ.anticipos.libro)} · pagos ${pesos(integ.anticipos.submayor)}</span></span><span class="v">${integ.anticipos.cuadra ? '✓' : html`<b class="neg-t">difiere</b>`}</span></li>
        </ul>
        <button class="link top-gap" data-action="reverificar">Verificar de nuevo</button></section>
      <section class="panel c7 flush"><header><h2>Periodos</h2></header>
        ${tabla([{ t: 'Periodo', k: p => mesNombre(p.periodo) }, { t: 'Estado', k: p => html`${pill(p.estado === 'cerrado' ? ['Cerrado', 'neutral'] : ['Abierto', 'warn'])}` }, { t: 'Pólizas', num: true, k: p => p.polizas },
          { t: 'Cerró', k: p => p.cerrado_at ? html`${p.cerro || '—'}<span class="sub-t">${fechaHora(p.cerrado_at)}</span>` : '' },
          { t: '', k: p => p.periodo === ultimoCerrado && S.me.superadmin ? html`<button class="link neg" data-action="reabrir" data-p="${p.periodo}">Reabrir</button>` : '' }], ps)}</section>
      <section class="panel c5"><header><h2>Cierre del ejercicio ${anioAnt}</h2></header>
        <p class="lead small">Traspasa el resultado del año (ingresos menos egresos) a «Remanente de ejercicios anteriores» con una póliza de cierre al 31 de diciembre. Diciembre debe estar abierto para registrarla; ciérrelo después.</p>
        ${puede('cerrar') ? html`<button class="btn top-gap" data-action="ejercicio" data-a="${anioAnt}">Cerrar ejercicio ${anioAnt}</button>` : ''}</section>
    </div>`);
  ctx.acciones({
    cerrar: async d => {
      if (!await confirmar(`Cerrar ${mesNombre(d.p)}`, 'Se creará un respaldo cifrado y el mes quedará bloqueado. Las correcciones posteriores se registrarán en el mes abierto, nunca en el cerrado.', { label: 'Cerrar mes' })) return;
      await capi(`/periodos/${d.p}/cerrar`, { method: 'POST', body: {} }); toast(`${mesNombre(d.p)} cerrado.`); ctx.recargar();
    },
    reabrir: async d => { const motivo = await pedirMotivo(`Reabrir ${mesNombre(d.p)}`, 'Solo el superadministrador puede reabrir el último mes cerrado. Quedará registrado en la bitácora.', 'Reabrir'); if (!motivo) return; await capi(`/periodos/${d.p}/reabrir`, { method: 'POST', body: { motivo } }); toast('Periodo reabierto.'); ctx.recargar(); },
    ejercicio: async d => { if (!await confirmar(`Cerrar ejercicio ${d.a}`, 'Se registrará la póliza de cierre del ejercicio.', { label: 'Cerrar ejercicio' })) return; await capi(`/ejercicios/${d.a}/cerrar`, { method: 'POST', body: {} }); toast(`Ejercicio ${d.a} cerrado.`); ctx.recargar(); },
    reverificar: () => ctx.recargar(),
  });
}

const item = (ok, label, detalle, href, opcional = false) => html`<li><a class="row-link t" href="${href}"><span><b>${label}</b><span>${detalle}</span></span></a><span class="v">${ok ? '✓' : opcional ? html`<span class="pill warn">recomendado</span>` : html`<span class="pill neg">pendiente</span>`}</span></li>`;
