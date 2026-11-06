// Configuración del condominio: datos, parámetros de cobranza y controles.
import { capi, html, mount, puede, toast, val, pesos, pesosDe, centsToInput, cargando, tabla, pill, dialogo } from '../ui.js';

export async function render(el, ctx) {
  cargando(el);
  const [c, fondos] = await Promise.all([capi('/config'), capi('/fondos')]);
  const ro = puede('config') ? '' : 'disabled';
  const sec = (titulo, desc, campos) => html`<section class="set-row"><div class="set-label"><h2>${titulo}</h2><p>${desc}</p></div><div class="set-panel">${campos}</div></section>`;
  mount(el, html`<div class="title-row"><div><h1>Configuración</h1><p class="sub">${puede('config') ? 'Los cambios quedan registrados en la bitácora con el valor anterior.' : 'Solo la administración puede modificar estos parámetros.'}</p></div></div>
    <form class="settings" data-f>
      ${sec('Datos del condominio', 'Aparecen en estados de cuenta, recibos, constancias e informes.', html`<div class="form-grid">
        <label class="field full"><span>Nombre</span><input name="nombre" value="${c.nombre}" required maxlength="120" ${ro}></label>
        <label class="field full"><span>Razón social</span><input name="razon_social" value="${c.razon_social || ''}" maxlength="160" ${ro}></label>
        <label class="field"><span>RFC</span><input name="rfc" value="${c.rfc || ''}" maxlength="13" ${ro}></label>
        <label class="field"><span>Ciudad</span><input name="ciudad" value="${c.ciudad || ''}" maxlength="80" ${ro}></label>
        <label class="field full"><span>Domicilio</span><input name="direccion" value="${c.direccion || ''}" maxlength="250" ${ro}></label></div>`)}
      ${sec('Cobranza', 'Vencimiento de las cuotas, tolerancia antes de generar recargos y tasa moratoria mensual según el reglamento del condominio.', html`<div class="form-grid">
        <label class="field"><span>Día de vencimiento</span><input name="dia" type="number" min="1" max="28" value="${c.dia_vencimiento}" ${ro}></label>
        <label class="field"><span>Días de gracia</span><input name="gracia" type="number" min="0" max="60" value="${c.dias_gracia}" ${ro}></label>
        <label class="field"><span>Recargo mensual (%)</span><input name="tasa" class="num-in" value="${(c.tasa_recargo_bp / 100).toFixed(2)}" ${ro}></label>
        <label class="field"><span>Aportación al fondo de reserva (% de la cuota)</span><input name="reserva" class="num-in" value="${(c.pct_reserva_bp / 100).toFixed(2)}" ${ro}></label></div>`)}
      ${sec('Descuento por pronto pago', 'Se aplica solo al registrar o validar un pago que liquida la cuota ordinaria completa a más tardar el día indicado del mes de la cuota. Queda como bonificación con su póliza. Deje 0 para desactivarlo.', html`<div class="form-grid">
        <label class="field"><span>Descuento (% de la cuota)</span><input name="pp_pct" class="num-in" value="${((c.pronto_pago_bp || 0) / 100).toFixed(2)}" ${ro}></label>
        <label class="field"><span>Pagando a más tardar el día</span><input name="pp_dia" type="number" min="0" max="28" value="${c.pronto_pago_dia || 0}" ${ro}></label></div>`)}
      ${sec('Controles', 'Los egresos de este importe o más, y todo uso del fondo de reserva, necesitan la aprobación de un segundo usuario.', html`<div class="form-grid">
        <label class="field"><span>Umbral de aprobación</span><input name="umbral" class="num-in" value="${centsToInput(c.umbral_aprobacion_cents)}" ${ro}></label>
        <p class="note">Hoy: ${pesos(c.umbral_aprobacion_cents)}</p></div>`)}
      ${puede('config') ? html`<div class="set-actions"><button class="btn primary">Guardar configuración</button></div>` : ''}
    </form>
    <section class="set-row"><div class="set-label"><h2>Fondos</h2><p>Además del fondo de reserva, puede tener fondos para proyectos (pintura, impermeabilización, elevadores). Reciben cuotas extraordinarias y pagan sus egresos con aprobación de un segundo usuario.</p></div>
      <div class="set-panel">${tabla([{ t: 'Fondo', k: x => html`<b>${x.nombre}</b><span class="sub-t">${x.codigo}${x.descripcion ? ` · ${x.descripcion}` : ''}</span>` }, { t: 'Meta', num: true, k: x => x.meta_cents ? pesos(x.meta_cents) : '—' },
        { t: '', k: x => pill(x.activo ? ['Activo', 'pos'] : ['Inactivo', 'neutral']) }], fondos, { vacio: 'Solo el fondo de reserva.' })}
        ${puede('config') ? html`<button class="btn top-gap" type="button" data-action="fondo">Nuevo fondo</button>` : ''}
        <p class="small muted top-gap">El saldo y los movimientos de cada fondo están en Reportes → Fondos.</p></div></section>`);
  ctx.acciones({
    fondo: () => dialogo({
      titulo: 'Nuevo fondo', cuerpo: html`<div class="form-grid">
        <label class="field full"><span>Nombre</span><input name="nombre" required maxlength="80" placeholder="Pintura de fachadas 2027"></label>
        <label class="field"><span>Meta <span class="hint">· opcional</span></span><input name="meta" class="num-in" inputmode="decimal"></label>
        <label class="field full"><span>Descripción <span class="hint">· opcional</span></span><input name="desc" maxlength="300" placeholder="Aprobado en asamblea del …"></label>
        <p class="note full">Se crea su cuenta de patrimonio en el catálogo contable.</p></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Crear fondo', primary: true }],
      onSubmit: async f => { await capi('/fondos', { method: 'POST', body: { nombre: val(f, 'nombre'), meta_cents: val(f, 'meta') ? pesosDe(f, 'meta') : null, descripcion: val(f, 'desc') || null } }); toast('Fondo creado.'); ctx.recargar(); },
    }),
  });
  el.querySelector('[data-f]').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const bp = (s, max) => { const n = parseFloat(String(s).replace('%', '')); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Revise los porcentajes.'); return Math.round(n * 100); };
    try {
      await capi('/config', { method: 'PUT', body: { nombre: val(f, 'nombre'), razon_social: val(f, 'razon_social') || null, rfc: val(f, 'rfc') || null, ciudad: val(f, 'ciudad') || null, direccion: val(f, 'direccion') || null,
        dia_vencimiento: +f.dia.value, dias_gracia: +f.gracia.value, tasa_recargo_bp: bp(f.tasa.value, 20), pct_reserva_bp: bp(f.reserva.value, 50), umbral_aprobacion_cents: pesosDe(f, 'umbral', { cero: true }),
        pronto_pago_bp: bp(f.pp_pct.value || 0, 50), pronto_pago_dia: +f.pp_dia.value || 0 } });
      toast('Configuración guardada.'); ctx.recargar();
    } catch (err) { toast(err.message, 'error'); }
  });
}
