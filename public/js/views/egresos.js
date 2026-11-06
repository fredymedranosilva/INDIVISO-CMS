// Egresos: captura con CFDI, aprobación por un segundo usuario, pago a proveedores.
import { S, capi, html, raw, mount, $, pesos, fecha, hoy, addMonths, periodoActual, puede, tabla, m, pill, ESTADO_EGRESO, toast, dialogo, val, pesosDe, centsToInput, idem, descargar, cargando, tabs, leerArchivo, confirmar } from '../ui.js';
import { bancos, subirArchivo, pedirMotivo } from './comun.js';
import { refrescarContadores } from '../app.js';
import { abrirImportacion } from './importar.js';

export async function render(el, ctx) {
  const [sub, qs] = (ctx.params[0] || 'egresos').split('?');
  const q = new URLSearchParams(qs || '');
  cargando(el);
  const [t, c] = await Promise.all([capi('/tablero'), capi('/config')]);
  mount(el, html`<div class="title-row"><div><h1>Egresos</h1><p class="sub">Todo egreso de ${pesos(c.umbral_aprobacion_cents)} o más, y todo uso del fondo de reserva, requiere aprobación de un usuario distinto a quien lo capturó.</p></div>
    <div class="actions">${puede('capturar') ? html`<button class="btn" data-action="importarEgresos">Importar desde Excel</button><button class="btn primary" data-action="nuevo">Capturar egreso</button>` : ''}</div></div>
    ${tabs([['egresos', 'Egresos'], ['aprobar', 'Por aprobar', t.pendientes.egresos_por_aprobar], ['porpagar', 'Cuentas por pagar'], ['proveedores', 'Proveedores']], sub, ctx.base)}<div id="eg-body"></div>`);
  ctx.acciones({ nuevo: () => capturar(ctx), importarEgresos: () => abrirImportacion('egresos', { onOk: () => ctx.recargar() }) });
  const body = $('#eg-body', el);
  if (sub === 'proveedores') return proveedores(body, ctx);
  if (sub === 'porpagar') { await porPagar(body); return lista($('#eg-lista', body), ctx, { estado: 'aprobado' }, 'pagar'); }
  return lista(body, ctx, sub === 'aprobar' ? { estado: 'por_aprobar' } : { estado: q.get('estado') || '', desde: q.get('desde') || `${addMonths(periodoActual(), -2)}-01`, hasta: q.get('hasta') || hoy() }, sub === 'aprobar');
}

// Cuentas por pagar: egresos aprobados sin pagar, por proveedor y antigüedad.
async function porPagar(el) {
  const r = await capi('/reportes/cxp');
  const t = r.totales;
  mount(el, html`<div class="grid top">
    <section class="panel c12"><header><h2>Por pagar a proveedores</h2><span class="meta">Antigüedad desde la fecha del gasto · ${r.por_aprobar.n ? `${r.por_aprobar.n} más esperando aprobación (${pesos(r.por_aprobar.s)})` : 'nada esperando aprobación'}</span></header>
      <div class="kpis"><div class="kpi"><p class="label">Total por pagar</p><p class="kpi-value md">${pesos(t.total)}</p></div><div class="kpi"><p class="label">0 a 30 días</p><p class="kpi-value md">${pesos(t.d30)}</p></div>
        <div class="kpi"><p class="label">31 a 60 días</p><p class="kpi-value md">${pesos(t.d60)}</p></div><div class="kpi"><p class="label">61 a 90 días</p><p class="kpi-value md ${t.d90 ? 'neg-t' : ''}">${pesos(t.d90)}</p></div>
        <div class="kpi"><p class="label">Más de 90 días</p><p class="kpi-value md ${t.d90mas ? 'neg-t' : ''}">${pesos(t.d90mas)}</p></div></div></section>
    <section class="panel flush c12"><header><h2>Por proveedor</h2></header>
      ${tabla([{ t: 'Proveedor', k: x => html`<b>${x.proveedor}</b><span class="sub-t">${x.documentos} ${x.documentos === 1 ? 'documento' : 'documentos'}</span>` }, { t: '0–30', num: true, k: x => m(x.d30) }, { t: '31–60', num: true, k: x => m(x.d60) },
        { t: '61–90', num: true, k: x => m(x.d90) }, { t: '+90', num: true, k: x => m(x.d90mas) }, { t: 'Total', num: true, k: x => html`<b>${pesos(x.total)}</b>` }], r.proveedores, { vacio: 'No hay cuentas por pagar.', pie: r.proveedores.length ? ['Total', pesos(t.d30), pesos(t.d60), pesos(t.d90), pesos(t.d90mas), pesos(t.total)] : null })}</section>
    <div class="c12" id="eg-lista"></div></div>`);
}

async function lista(el, ctx, f, cola) {
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [rows, bs] = await Promise.all([capi(`/egresos?${qs}`), bancos()]);
  const vigentes = rows.filter(r => ['aprobado', 'pagado'].includes(r.estado));
  mount(el, html`
    ${cola ? '' : html`<form class="filters" data-filtros>
      <label class="field"><span>Desde</span><input type="date" name="desde" value="${f.desde}"></label>
      <label class="field"><span>Hasta</span><input type="date" name="hasta" value="${f.hasta}"></label>
      <label class="field"><span>Estado</span><select name="estado"><option value="">Todos</option>${Object.entries(ESTADO_EGRESO).map(([k, [l]]) => html`<option value="${k}" ${k === f.estado ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <button class="btn">Filtrar</button><span class="spacer"></span><button class="btn ghost" type="button" data-action="csv">Exportar CSV</button></form>`}
    <section class="panel flush"><header><h2>${cola === 'pagar' ? 'Documentos por pagar' : cola ? 'Esperando aprobación' : `${rows.length} egresos`}</h2><span class="meta">${cola === 'pagar' ? 'Registre el pago para que salga de bancos y de proveedores por pagar.' : cola ? 'Revise la factura y la partida antes de aprobar.' : `Aprobados y pagados: ${pesos(vigentes.reduce((a, r) => a + r.total_cents, 0))}`}</span></header>
    ${tabla([
      { t: 'Folio', k: r => `E-${r.folio}` },
      { t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' },
      { t: 'Concepto', k: r => html`${r.concepto}<span class="sub-t">${r.proveedor || 'Sin proveedor'}${r.fondo === 'reserva' ? ` · ${r.fondo_nombre ? `fondo ${r.fondo_nombre}` : 'fondo de reserva'}` : ''}</span>` },
      { t: 'Partida', k: r => html`${r.partida}<span class="sub-t">${r.partida_codigo}</span>`, cls: 'hide-m' },
      { t: 'Factura', k: r => r.cfdi_uuid ? html`<span title="${r.cfdi_uuid}">${r.factura_folio || 'CFDI'} · ${r.cfdi_uuid.slice(0, 8)}…</span>` : html`<span class="faint">—</span>`, cls: 'hide-m' },
      { t: 'Total', num: true, k: r => m(r.total_cents) },
      { t: 'Estado', k: r => html`${pill(ESTADO_EGRESO[r.estado])}<span class="sub-t">${r.capturo ? `capturó ${r.capturo.split(' ').slice(0, 2).join(' ')}` : ''}${r.aprobo && r.estado !== 'por_aprobar' ? ` · aprobó ${r.aprobo.split(' ').slice(0, 2).join(' ')}` : ''}</span>` },
      { t: '', k: r => html`<span class="row-actions">
        ${r.comprobante_id ? html`<button class="link" data-action="comp" data-id="${r.comprobante_id}" data-nombre="${r.comprobante_nombre}">Factura</button>` : ''}
        ${r.estado === 'por_aprobar' && puede('aprobar') ? html`<button class="btn sm primary" data-action="aprobar" data-id="${r.id}">Aprobar</button><button class="btn sm" data-action="rechazar" data-id="${r.id}">Rechazar</button>` : ''}
        ${r.estado === 'aprobado' && puede('capturar') ? html`<button class="btn sm" data-action="pagar" data-id="${r.id}" data-total="${r.total_cents}" data-folio="${r.folio}">Pagar</button>` : ''}
        ${['aprobado', 'pagado', 'por_aprobar'].includes(r.estado) && puede('cancelar') ? html`<button class="link neg" data-action="cancelar" data-id="${r.id}" data-folio="${r.folio}">Cancelar</button>` : ''}</span>` },
    ], rows, { vacio: cola === 'pagar' ? 'No hay egresos por pagar.' : cola ? 'No hay egresos esperando aprobación.' : 'Sin egresos en el rango.' })}</section>`);
  $('[data-filtros]', el)?.addEventListener('submit', e => { e.preventDefault(); const x = e.target; location.hash = `${ctx.base}/egresos?desde=${x.desde.value}&hasta=${x.hasta.value}&estado=${x.estado.value}`; });
  ctx.acciones({
    csv: () => descargar(`/api/c/${S.cid}/export/egresos.csv`, 'egresos.csv'),
    comp: d => descargar(`/api/c/${S.cid}/archivos/${d.id}`, d.nombre),
    aprobar: async d => { if (!await confirmar('Aprobar egreso', 'Al aprobarlo se registra la provisión contable (gasto contra proveedores por pagar).', { label: 'Aprobar' })) return; await capi(`/egresos/${d.id}/aprobar`, { method: 'POST', body: { aprobar: true } }); toast('Egreso aprobado.'); refrescarContadores(); ctx.recargar(); },
    rechazar: async d => { const motivo = await pedirMotivo('Rechazar egreso', 'El egreso quedará rechazado y no afectará la contabilidad.', 'Rechazar'); if (!motivo) return; await capi(`/egresos/${d.id}/aprobar`, { method: 'POST', body: { aprobar: false, motivo } }); refrescarContadores(); ctx.recargar(); },
    cancelar: async d => { const motivo = await pedirMotivo(`Cancelar egreso E-${d.folio}`, 'Se registrarán contrapólizas de la provisión y, si ya se pagó, del pago.', 'Cancelar egreso'); if (!motivo) return; await capi(`/egresos/${d.id}/cancelar`, { method: 'POST', body: { motivo } }); toast('Egreso cancelado.'); ctx.recargar(); },
    pagar: d => dialogo({
      titulo: `Pagar egreso E-${d.folio}`, cuerpo: html`<p class="lead">Importe: <b>${pesos(+d.total)}</b></p><div class="form-grid">
        <label class="field"><span>Fecha de pago</span><input type="date" name="fecha" value="${hoy()}" max="${hoy()}" required></label>
        <label class="field"><span>Método</span><select name="metodo"><option value="transferencia">Transferencia</option><option value="cheque">Cheque</option><option value="domiciliacion">Domiciliación</option><option value="tarjeta">Tarjeta</option><option value="efectivo">Efectivo (caja)</option></select></label>
        <label class="field full"><span>Cuenta de cargo</span><select name="banco">${bs.map(b => html`<option value="${b.id}">${b.banco} · ${b.nombre} · ${pesos(b.saldo_cents)}</option>`)}<option value="">Caja</option></select></label>
        <label class="field full"><span>Referencia o clave de rastreo</span><input name="ref" maxlength="60"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar pago', primary: true }],
      onSubmit: async f => { await capi(`/egresos/${d.id}/pagar`, { method: 'POST', body: { fecha_pago: val(f, 'fecha'), metodo: f.metodo.value, cuenta_banco_id: f.banco.value ? +f.banco.value : null, referencia: val(f, 'ref') || null } }); toast('Pago a proveedor registrado.'); ctx.recargar(); },
    }),
  });
}

async function capturar(ctx) {
  const [cuentas, provs, c, fondos] = await Promise.all([capi('/cuentas'), capi('/proveedores'), capi('/config'), capi('/fondos')]);
  const partidas = cuentas.filter(k => k.tipo === 'egreso' && k.activo);
  const key = idem();
  let comprobante = null;
  dialogo({
    titulo: 'Capturar egreso', ancho: 'wide',
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Factura (XML del CFDI o PDF) <span class="hint">· con el XML se llenan los datos y se valida que el UUID no esté registrado</span></span><input type="file" name="archivo" accept=".xml,.pdf,.png,.jpg,.jpeg"></label>
      <p class="note full" data-cfdi hidden></p>
      <label class="field"><span>Proveedor</span><select name="prov"><option value="">Sin proveedor</option>${provs.filter(p => p.activo).map(p => html`<option value="${p.id}" data-rfc="${p.rfc || ''}">${p.nombre}</option>`)}</select></label>
      <label class="field"><span>Partida presupuestal</span><select name="cuenta" required>${partidas.map(k => html`<option value="${k.id}">${k.codigo} · ${k.nombre}</option>`)}</select></label>
      <label class="field full"><span>Concepto</span><input name="concepto" required maxlength="200"></label>
      <label class="field"><span>Fecha del gasto</span><input type="date" name="fecha" value="${hoy()}" max="${hoy()}" required></label>
      <label class="field"><span>Fondo</span><select name="fondo"><option value="operacion">Operación</option><option value="reserva">Fondo de reserva (requiere aprobación)</option>${fondos.filter(x => x.activo).map(x => html`<option value="fondo:${x.id}">Fondo ${x.nombre} (requiere aprobación)</option>`)}</select></label>
      <label class="field"><span>Subtotal</span><input name="sub" class="num-in" inputmode="decimal" required></label>
      <label class="field"><span>IVA <button type="button" class="link small" data-iva>calcular 16%</button></span><input name="iva" class="num-in" inputmode="decimal" value="0.00"></label>
      <label class="field"><span>Retenciones</span><input name="ret" class="num-in" inputmode="decimal" value="0.00"></label>
      <div class="field"><span>Total</span><p class="kpi-value md num" data-total>$0.00</p></div>
      <label class="field"><span>Folio de factura</span><input name="folio" maxlength="40"></label>
      <label class="field"><span>UUID del CFDI</span><input name="uuid" maxlength="36" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"></label>
      <p class="note full">Si el total es de ${pesos(c.umbral_aprobacion_cents)} o más, quedará pendiente de aprobación por otro usuario.</p></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar egreso', primary: true }],
    onOpen: (d, f) => {
      const recalc = () => { try { d.querySelector('[data-total]').textContent = pesos(pesosDe(f, 'sub', { cero: true }) + pesosDe(f, 'iva', { requerido: false, cero: true }) - pesosDe(f, 'ret', { requerido: false, cero: true })); } catch { d.querySelector('[data-total]').textContent = '—'; } };
      for (const n of ['sub', 'iva', 'ret']) f[n].addEventListener('input', recalc);
      d.querySelector('[data-iva]').addEventListener('click', () => { try { f.iva.value = centsToInput(Math.round(pesosDe(f, 'sub') * 0.16)); recalc(); } catch { /* sin subtotal */ } });
      f.archivo.addEventListener('change', async () => {
        const file = f.archivo.files[0]; if (!file) return;
        const nota = d.querySelector('[data-cfdi]');
        try {
          if (/\.xml$/i.test(file.name)) {
            const x = await capi('/cfdi/leer', { method: 'POST', body: { base64: await leerArchivo(file) } });
            if (x.subtotal_cents != null) f.sub.value = centsToInput(x.subtotal_cents);
            f.iva.value = centsToInput(x.iva_cents); f.ret.value = centsToInput(x.retenciones_cents);
            f.uuid.value = x.uuid; f.folio.value = [x.serie, x.folio].filter(Boolean).join('');
            if (x.fecha && x.fecha <= hoy()) f.fecha.value = x.fecha;
            if (x.proveedor) f.prov.value = x.proveedor.id;
            nota.className = `note full ${x.duplicado ? 'neg' : 'pos'}`;
            nota.textContent = x.duplicado ? `Esta factura ya está registrada como ${x.duplicado}.` : `CFDI de ${x.emisor_nombre || x.emisor_rfc} por ${pesos(x.total_cents)}${x.proveedor ? '' : ' · el RFC emisor no está en su catálogo de proveedores'}.`;
            nota.hidden = false; recalc();
          }
          comprobante = (await subirArchivo(file)).id;
        } catch (e) { nota.className = 'note full neg'; nota.textContent = e.message; nota.hidden = false; }
      });
    },
    onSubmit: async f => {
      const r = await capi('/egresos', { method: 'POST', body: {
        proveedor_id: f.prov.value ? +f.prov.value : null, cuenta_id: +f.cuenta.value, fondo: f.fondo.value.startsWith('fondo:') ? 'reserva' : f.fondo.value, fondo_id: +f.fondo.value.split(':')[1] || null, fecha: val(f, 'fecha'), concepto: val(f, 'concepto'),
        subtotal_cents: pesosDe(f, 'sub', { cero: true }), iva_cents: pesosDe(f, 'iva', { requerido: false, cero: true }), retenciones_cents: pesosDe(f, 'ret', { requerido: false, cero: true }),
        factura_folio: val(f, 'folio') || null, cfdi_uuid: val(f, 'uuid') || null, comprobante_id: comprobante, idem_key: key } });
      toast(r.requiere_aprobacion ? `Egreso E-${r.folio} capturado · espera aprobación` : `Egreso E-${r.folio} registrado y provisionado`);
      refrescarContadores(); ctx.recargar();
    },
  });
}

async function proveedores(el, ctx) {
  const rows = await capi('/proveedores');
  mount(el, html`<div class="filters"><span class="spacer"></span>${puede('capturar') ? html`<button class="btn" data-action="importarProv">Importar desde Excel</button><button class="btn" data-action="nuevoProv">Nuevo proveedor</button>` : ''}</div>
    <section class="panel flush"><header><h2>${rows.length} proveedores</h2><span class="meta">El RFC es único: no se pueden duplicar proveedores.</span></header>
    ${tabla([{ t: 'Proveedor', k: p => html`<b>${p.nombre}</b><span class="sub-t">${p.giro || ''}</span>` }, { t: 'RFC', k: p => p.rfc || '—' }, { t: 'Contacto', k: p => [p.email, p.telefono].filter(Boolean).join(' · ') || html`<span class="faint">—</span>`, cls: 'hide-m' },
      { t: 'CLABE', k: p => p.clabe_mask || html`<span class="faint">—</span>`, cls: 'hide-m' }, { t: `Ejercido ${hoy().slice(0, 4)}`, num: true, k: p => m(p.ejercido_anio) }, { t: '', k: p => p.activo ? '' : pill(['Inactivo', 'neutral']) }], rows)}</section>`);
  ctx.acciones({
    importarProv: () => abrirImportacion('proveedores', { onOk: () => ctx.recargar() }),
    nuevoProv: () => dialogo({
      titulo: 'Nuevo proveedor', cuerpo: html`<div class="form-grid">
        <label class="field full"><span>Razón social</span><input name="nombre" required maxlength="160"></label>
        <label class="field"><span>RFC</span><input name="rfc" maxlength="13"></label><label class="field"><span>Giro</span><input name="giro" maxlength="80"></label>
        <label class="field"><span>Correo</span><input name="email" type="email"></label><label class="field"><span>Teléfono</span><input name="tel" maxlength="30"></label>
        <label class="field full"><span>CLABE <span class="hint">· se guarda enmascarada</span></span><input name="clabe" inputmode="numeric" maxlength="18"></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', primary: true }],
      onSubmit: async f => { await capi('/proveedores', { method: 'POST', body: { nombre: val(f, 'nombre'), rfc: val(f, 'rfc') || null, giro: val(f, 'giro') || null, email: val(f, 'email') || null, telefono: val(f, 'tel') || null, clabe: val(f, 'clabe') || null } }); toast('Proveedor registrado.'); ctx.recargar(); },
    }),
  });
}
