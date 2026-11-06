// Cobranza: pagos, validación de comprobantes, emisión de cuotas, recargos, extraordinarias y convenios.
import { S, capi, html, raw, mount, $, pesos, fecha, mesNombre, periodoActual, addMonths, hoy, puede, tabla, m, pill, ESTADO_PAGO, METODOS, toast, dialogo, confirmar, val, pesosDe, descargar, cargando, barra, tabs, pct } from '../ui.js';
import { dialogoPago, imprimirRecibo, bancos, unidades, invalidar, opcionesUnidad, pedirMotivo } from './comun.js';
import { refrescarContadores } from '../app.js';
import { abrirImportacion } from './importar.js';

export async function render(el, ctx) {
  const [sub, qs] = (ctx.params[0] || 'pagos').split('?');
  const q = new URLSearchParams(qs || '');
  cargando(el);
  const t = await capi('/tablero');
  const head = html`<div class="title-row"><div><h1>Cobranza</h1><p class="sub">Recibos, comprobantes reportados por residentes, emisión mensual y convenios de pago.</p></div>
    <div class="actions">${puede('capturar') ? html`<button class="btn" data-action="importarPagos">Importar desde Excel</button><button class="btn primary" data-action="pago">Registrar pago</button>` : ''}</div></div>
    ${tabs([['pagos', 'Pagos'], ['validar', 'Por validar', t.pendientes.pagos_por_validar], ['emision', 'Emisión y recargos'], ['convenios', 'Convenios']], sub, ctx.base)}`;
  const cuerpo = html`<div id="cob-body"></div>`;
  mount(el, html`${head}${cuerpo}`);
  const body = $('#cob-body', el);
  ctx.acciones({ pago: () => dialogoPago({ onOk: () => ctx.recargar() }), importarPagos: () => abrirImportacion('pagos', { onOk: () => ctx.recargar() }) });
  await ({ pagos, validar, emision, convenios }[sub] || pagos)(body, ctx, q);
}

async function pagos(el, ctx, q) {
  const desde = q.get('desde') || `${addMonths(periodoActual(), -1)}-01`, hasta = q.get('hasta') || hoy(), estado = q.get('estado') || '';
  const rows = await capi(`/pagos?desde=${desde}&hasta=${hasta}${estado ? `&estado=${estado}` : ''}`);
  const aplicados = rows.filter(r => r.estado === 'aplicado');
  mount(el, html`
    <form class="filters" data-filtros>
      <label class="field"><span>Desde</span><input type="date" name="desde" value="${desde}"></label>
      <label class="field"><span>Hasta</span><input type="date" name="hasta" value="${hasta}"></label>
      <label class="field"><span>Estado</span><select name="estado"><option value="">Todos</option>${Object.entries(ESTADO_PAGO).map(([k, [l]]) => html`<option value="${k}" ${k === estado ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <button class="btn">Filtrar</button><span class="spacer"></span>
      <button class="btn ghost" type="button" data-action="csv">Exportar CSV</button>
    </form>
    <section class="panel flush">
      <header><h2>${rows.length} pagos</h2><span class="meta">Aplicados: ${pesos(aplicados.reduce((a, r) => a + r.monto_cents, 0))}</span></header>
      ${tabla([
        { t: 'Recibo', k: r => r.folio ? `R-${r.folio}` : html`<span class="faint">—</span>` },
        { t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' },
        { t: 'Unidad', k: r => html`<a class="link" href="#/c/${S.cid}/unidades/${r.unidad_id}">${r.clave}</a>` },
        { t: 'Método', k: r => html`${METODOS[r.metodo]}<span class="sub-t">${r.banco ? `${r.banco} · ${r.cuenta_nombre}` : 'Caja'}</span>` },
        { t: 'Referencia', k: r => r.referencia || html`<span class="faint">—</span>`, cls: 'hide-m' },
        { t: 'Importe', num: true, k: r => m(r.monto_cents) },
        { t: 'Estado', k: r => html`${pill(ESTADO_PAGO[r.estado])}${r.conciliado ? html` <span class="pill pos" title="Conciliado con el estado de cuenta bancario">conciliado</span>` : ''}` },
        { t: '', k: r => html`<span class="row-actions">${r.folio ? html`<button class="link" data-action="recibo" data-id="${r.id}">Recibo</button>` : ''}${puede('cancelar') && r.estado === 'aplicado' ? html`<button class="link neg" data-action="cancelar" data-id="${r.id}" data-folio="${r.folio}">Cancelar</button>` : ''}</span>` },
      ], rows, { vacio: 'Sin pagos en el rango seleccionado.' })}
    </section>`);
  $('[data-filtros]', el).addEventListener('submit', e => { e.preventDefault(); const f = e.target; location.hash = `${ctx.base}/pagos?desde=${f.desde.value}&hasta=${f.hasta.value}&estado=${f.estado.value}`; });
  ctx.acciones({
    recibo: d => imprimirRecibo(d.id),
    csv: () => descargar(`/api/c/${S.cid}/export/pagos.csv`, 'pagos.csv'),
    cancelar: async d => {
      const motivo = await pedirMotivo(`Cancelar recibo R-${d.folio}`, 'Se registrará una contrapóliza que revierte el cobro y reabre los cargos que pagó. El recibo original se conserva como cancelado.', 'Cancelar recibo');
      if (!motivo) return;
      await capi(`/pagos/${d.id}/cancelar`, { method: 'POST', body: { motivo } }); invalidar(); toast('Recibo cancelado y revertido.'); ctx.recargar();
    },
  });
}

async function validar(el, ctx) {
  const [rows, bs] = await Promise.all([capi('/pagos?estado=por_validar'), bancos()]);
  mount(el, html`<section class="panel flush">
    <header><h2>Pagos reportados por residentes</h2><span class="meta">Revise el comprobante contra el estado de cuenta bancario antes de aceptar.</span></header>
    ${tabla([
      { t: 'Reportado', k: r => fecha(r.fecha), cls: 'nowrap' },
      { t: 'Unidad', k: r => html`<a class="link" href="#/c/${S.cid}/unidades/${r.unidad_id}">${r.clave}</a>` },
      { t: 'Método', k: r => html`${METODOS[r.metodo]}<span class="sub-t">${r.referencia || 'sin referencia'}</span>` },
      { t: 'Comprobante', k: r => r.comprobante_id ? html`<button class="link" data-action="comp" data-id="${r.comprobante_id}" data-nombre="${r.comprobante_nombre}">${r.comprobante_nombre}</button>` : html`<span class="faint">—</span>` },
      { t: 'Importe', num: true, k: r => m(r.monto_cents) },
      { t: '', k: r => puede('capturar') ? html`<span class="row-actions"><button class="btn sm primary" data-action="aceptar" data-id="${r.id}" data-banco="${r.cuenta_banco_id || ''}">Aceptar</button><button class="btn sm" data-action="rechazar" data-id="${r.id}">Rechazar</button></span>` : '' },
    ], rows, { vacio: 'No hay pagos pendientes de validar.' })}</section>`);
  ctx.acciones({
    comp: d => descargar(`/api/c/${S.cid}/archivos/${d.id}`, d.nombre),
    aceptar: d => dialogo({
      titulo: 'Aceptar pago reportado',
      cuerpo: html`<p class="lead">El pago se aplicará a los cargos más antiguos de la unidad y se emitirá su recibo.</p>
        <label class="field"><span>Cuenta donde se recibió</span><select name="banco">${bs.map(b => html`<option value="${b.id}" ${String(b.id) === d.banco ? raw('selected') : ''}>${b.banco} · ${b.nombre}</option>`)}</select></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Aceptar y aplicar', primary: true }],
      onSubmit: async f => { const r = await capi(`/pagos/${d.id}/validar`, { method: 'POST', body: { aceptar: true, cuenta_banco_id: +f.banco.value } }); invalidar(); toast(`Pago aplicado · recibo R-${r.folio}`); refrescarContadores(); ctx.recargar(); },
    }),
    rechazar: async d => {
      const motivo = await pedirMotivo('Rechazar pago reportado', 'El residente verá el motivo en su portal.', 'Rechazar');
      if (!motivo) return;
      await capi(`/pagos/${d.id}/validar`, { method: 'POST', body: { aceptar: false, motivo } }); toast('Pago rechazado.'); ctx.recargar();
    },
  });
}

async function emision(el, ctx) {
  const [rows, c] = await Promise.all([capi('/emisiones'), capi('/config')]);
  const p = periodoActual();
  const opP = [-1, 0, 1].map(i => addMonths(p, i));
  mount(el, html`<div class="grid top">
    <section class="panel c4"><header><h2>Cuotas ordinarias</h2></header>
      <p class="lead small">Genera la cuota de cada unidad activa con vencimiento el día ${c.dia_vencimiento}. El ${(c.pct_reserva_bp / 100).toFixed(1)}% se aporta al fondo de reserva. Emitir dos veces el mismo mes no duplica cargos.</p>
      ${puede('capturar') ? html`<form class="filters top-gap" data-f="emitir"><label class="field"><span>Periodo</span><select name="periodo">${opP.map(x => html`<option value="${x}" ${x === p ? raw('selected') : ''}>${mesNombre(x)}</option>`)}</select></label><button class="btn primary">Emitir</button></form>` : ''}
    </section>
    <section class="panel c4"><header><h2>Recargos por mora</h2></header>
      <p class="lead small">${(c.tasa_recargo_bp / 100).toFixed(2)}% mensual sobre cuotas vencidas por más de ${c.dias_gracia} días de gracia. Nunca se cobran recargos sobre recargos, ni a unidades con convenio vigente.</p>
      ${puede('capturar') ? html`<form class="filters top-gap" data-f="recargos"><label class="field"><span>Periodo</span><select name="periodo">${opP.map(x => html`<option value="${x}" ${x === p ? raw('selected') : ''}>${mesNombre(x)}</option>`)}</select></label><button class="btn">Calcular recargos</button></form>` : ''}
    </section>
    <section class="panel c4"><header><h2>Otros cargos</h2></header>
      <p class="lead small">Cuotas extraordinarias aprobadas en asamblea (prorrateadas por indiviso o en partes iguales) y cargos a una unidad: multas u otros conceptos.</p>
      ${puede('capturar') ? html`<div class="actions top-gap"><button class="btn" data-action="extra">Cuota extraordinaria</button><button class="btn" data-action="individual">Cargo a una unidad</button></div>` : ''}
    </section>
    <section class="panel flush c12"><header><h2>Historial de emisiones</h2></header>
      ${tabla([{ t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' }, { t: 'Concepto', k: r => r.concepto }, { t: 'Póliza', k: r => html`<a class="link" href="#/c/${S.cid}/contabilidad/polizas/${r.id}">${r.tipo}-${r.folio}</a>` },
        { t: 'Cargos', num: true, k: r => r.cargos }, { t: 'Total', num: true, k: r => m(r.total_cents) }, { t: 'Emitió', k: r => r.autor || '—', cls: 'hide-m' }], rows, { vacio: 'Aún no hay emisiones.' })}
    </section></div>`);
  for (const f of el.querySelectorAll('form[data-f]')) f.addEventListener('submit', async e => {
    e.preventDefault();
    const tipo = f.dataset.f, periodo = f.periodo.value;
    const r = await capi(`/cobranza/${tipo}`, { method: 'POST', body: { periodo } }).catch(err => { toast(err.message, 'error'); return null; });
    if (!r) return;
    invalidar();
    toast(r.emitidos ? `${r.emitidos} ${tipo === 'emitir' ? 'cuotas' : 'recargos'} por ${pesos(r.total)}${r.omitidos ? ` · ${r.omitidos} ya existían` : ''}` : 'No se generaron cargos nuevos (ya existían o no hay saldo vencido).');
    ctx.recargar();
  });
  const us = await unidades();
  ctx.acciones({
    extra: () => dialogo({
      titulo: 'Cuota extraordinaria', ancho: 'wide',
      cuerpo: html`<div class="form-grid">
        <label class="field full"><span>Concepto aprobado en asamblea</span><input name="concepto" required maxlength="120" placeholder="Impermeabilización de azoteas"></label>
        <label class="field"><span>Importe total a recaudar</span><input name="total" class="num-in" inputmode="decimal" required></label>
        <label class="field"><span>Prorrateo</span><select name="metodo"><option value="indiviso">Por porcentaje de indiviso</option><option value="igual">Partes iguales</option></select></label>
        <label class="field"><span>Fecha de emisión</span><input name="fecha" type="date" value="${hoy()}" required></label>
        <label class="field"><span>Vencimiento</span><input name="vencimiento" type="date" value="${addMonths(p, 1)}-10" required></label>
        <label class="field full"><span>Destino</span><select name="destino"><option value="operacion">Gasto de operación (ingreso del ejercicio)</option><option value="reserva">Fondo de reserva (patrimonio)</option></select></label>
        <p class="note full">El reparto se hace sin perder centavos: la suma de los cargos es exactamente el total. Se aplica a todas las unidades activas (${us.filter(u => u.activo).length}).</p></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Emitir cuota extraordinaria', primary: true }],
      onSubmit: async f => {
        const r = await capi('/cobranza/extraordinaria', { method: 'POST', body: { concepto: val(f, 'concepto'), total_cents: pesosDe(f, 'total'), metodo: f.metodo.value, destino: f.destino.value, fecha: val(f, 'fecha'), vencimiento: val(f, 'vencimiento') } });
        invalidar(); toast(`${r.emitidos} cargos por ${pesos(r.total)}`); ctx.recargar();
      },
    }),
    individual: () => dialogo({
      titulo: 'Cargo a una unidad',
      cuerpo: html`<div class="form-grid">
        <label class="field full"><span>Unidad</span><select name="unidad">${opcionesUnidad(us)}</select></label>
        <label class="field"><span>Tipo</span><select name="tipo"><option value="multa">Multa o sanción</option><option value="otro">Otro concepto</option><option value="extraordinaria">Extraordinaria</option></select></label>
        <label class="field"><span>Importe</span><input name="monto" class="num-in" inputmode="decimal" required></label>
        <label class="field full"><span>Concepto</span><input name="concepto" required maxlength="120"></label>
        <label class="field"><span>Fecha</span><input name="fecha" type="date" value="${hoy()}" required></label>
        <label class="field"><span>Vencimiento</span><input name="vencimiento" type="date" value="${hoy()}"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar cargo', primary: true }],
      onSubmit: async f => { await capi('/cobranza/cargo', { method: 'POST', body: { unidad_id: +f.unidad.value, tipo: f.tipo.value, concepto: val(f, 'concepto'), monto_cents: pesosDe(f, 'monto'), fecha: val(f, 'fecha'), vencimiento: val(f, 'vencimiento') || null } }); invalidar(); toast('Cargo registrado.'); ctx.recargar(); },
    }),
  });
}

async function convenios(el, ctx) {
  const [rows, us] = await Promise.all([capi('/convenios'), unidades()]);
  const conVencido = us.filter(u => u.vencido > 0 && !u.convenio);
  mount(el, html`<div class="filters"><span class="spacer"></span>${puede('capturar') ? html`<button class="btn primary" data-action="nuevo" ${conVencido.length ? '' : raw('disabled')}>Nuevo convenio</button>` : ''}</div>
    <section class="panel flush"><header><h2>Convenios de pago</h2><span class="meta">Mientras el convenio está vigente se suspenden los recargos de la unidad.</span></header>
    ${tabla([
      { t: 'Unidad', k: r => html`<a class="link" href="#/c/${S.cid}/unidades/${r.unidad_id}">${r.clave}</a>` },
      { t: 'Firmado', k: r => fecha(r.fecha) },
      { t: 'Adeudo convenido', num: true, k: r => m(r.monto_cents) },
      { t: 'Parcialidades', num: true, k: r => r.parcialidades },
      { t: 'Avance', k: r => r.estado === 'vigente' ? html`<div class="hbar"><span>${pesos(r.pagado)} pagado</span><span class="num">${pct(r.pagado / r.monto_cents, 0)}</span>${barra(r.pagado / r.monto_cents)}</div>` : '' },
      { t: 'Estado', k: r => r.estado === 'vigente' ? pill(r.al_corriente ? ['Al corriente', 'pos'] : ['Atrasado', 'neg']) : pill([r.estado === 'cumplido' ? 'Cumplido' : 'Cancelado', r.estado === 'cumplido' ? 'pos' : 'neutral']) },
      { t: '', k: r => r.estado === 'vigente' && puede('cancelar') ? html`<button class="link neg" data-action="cancelar" data-id="${r.id}">Cancelar</button>` : '' },
    ], rows, { vacio: 'No hay convenios registrados.' })}</section>`);
  ctx.acciones({
    nuevo: () => dialogo({
      titulo: 'Nuevo convenio de pago',
      cuerpo: html`<div class="form-grid">
        <label class="field full"><span>Unidad con saldo vencido</span><select name="unidad">${conVencido.map(u => html`<option value="${u.id}">${u.clave} · ${pesos(u.vencido)} vencido</option>`)}</select></label>
        <label class="field"><span>Parcialidades mensuales</span><input name="parc" type="number" min="1" max="60" value="6" required></label>
        <label class="field"><span>Fecha de firma</span><input name="fecha" type="date" value="${hoy()}" required></label>
        ${puede('cancelar') ? html`<label class="check full"><input type="checkbox" name="condonar" checked><span>Condonar los recargos acumulados (se registra como bonificación)</span></label>` : ''}
        <label class="field full"><span>Notas</span><input name="notas" maxlength="300" placeholder="Firmado ante el comité de vigilancia"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar convenio', primary: true }],
      onSubmit: async f => { const r = await capi('/convenios', { method: 'POST', body: { unidad_id: +f.unidad.value, parcialidades: +f.parc.value, fecha: val(f, 'fecha'), condonar_recargos: !!f.condonar?.checked, notas: val(f, 'notas') || null } }); invalidar(); toast(`Convenio por ${pesos(r.monto_cents)} registrado.`); ctx.recargar(); },
    }),
    cancelar: async d => { if (!await confirmar('Cancelar convenio', 'La unidad volverá a generar recargos sobre su saldo vencido.', { label: 'Cancelar convenio', danger: true })) return; await capi(`/convenios/${d.id}/cancelar`, { method: 'POST', body: {} }); invalidar(); ctx.recargar(); },
  });
}
