// Diálogos y documentos compartidos entre pantallas.
import { S, capi, html, raw, dialogo, toast, val, pesosDe, idem, hoy, pesos, fecha, mesNombre, METODOS, tabla, m, imprimir, leerArchivo, confirmar, LOGO } from '../ui.js';
import { refrescarContadores } from '../app.js';

let cacheU = null, cacheB = null, cacheCid = null;
export async function unidades() { if (cacheCid !== S.cid) { cacheU = cacheB = null; cacheCid = S.cid; } return cacheU ??= await capi('/unidades'); }
export async function bancos() { if (cacheCid !== S.cid) { cacheU = cacheB = null; cacheCid = S.cid; } return cacheB ??= await capi('/bancos'); }
export const invalidar = () => { cacheU = cacheB = null; };

export const opcionesUnidad = (us, sel) => us.filter(u => u.activo).map(u => html`<option value="${u.id}" ${u.id === sel ? raw('selected') : ''}>${u.clave} · ${u.propietario || 'sin propietario'}</option>`);

// ---------- Registrar pago ----------
export async function dialogoPago({ unidad = null, onOk } = {}) {
  const [us, bs] = await Promise.all([unidades(), bancos()]);
  const key = idem();
  let confirmarDup = false;
  const saldoDe = id => { const u = us.find(x => x.id === +id); return u ? u.adeudo - u.saldo_favor : 0; };
  dialogo({
    titulo: 'Registrar pago', ancho: '',
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Unidad</span><select name="unidad" required>${opcionesUnidad(us, unidad)}</select></label>
      <p class="note full" data-saldo></p>
      <label class="field"><span>Importe</span><input name="monto" class="num-in" inputmode="decimal" required placeholder="0.00"></label>
      <label class="field"><span>Fecha de pago</span><input name="fecha" type="date" value="${hoy()}" max="${hoy()}" required></label>
      <label class="field"><span>Método</span><select name="metodo">${Object.entries(METODOS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
      <label class="field"><span>Cuenta de depósito</span><select name="banco">${bs.map(b => html`<option value="${b.id}" ${b.fondo === 'operacion' ? raw('selected') : ''}>${b.banco} · ${b.nombre} ${b.numero_mask || ''}</option>`)}<option value="">Caja (efectivo)</option></select></label>
      <label class="field full"><span>Clave de rastreo o folio de la operación <span class="hint">· evita registrar dos veces el mismo depósito</span></span><input name="referencia" maxlength="60" autocomplete="off"></label>
      <label class="field full"><span>Notas</span><input name="notas" maxlength="300"></label>
    </div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar y aplicar', primary: true }],
    onOpen: (d, f) => {
      const pintar = () => {
        const s = saldoDe(f.unidad.value);
        d.querySelector('[data-saldo]').textContent = s > 0 ? `Adeudo actual ${pesos(s)}. El pago se aplica primero a lo más antiguo; un excedente queda como saldo a favor.` : s < 0 ? `Saldo a favor de ${pesos(-s)}.` : 'La unidad está al corriente; el pago quedará como saldo a favor.';
        if (s > 0 && !f.monto.value) f.monto.placeholder = (s / 100).toFixed(2);
      };
      f.unidad.addEventListener('change', pintar); pintar();
      f.metodo.addEventListener('change', () => { if (f.metodo.value === 'efectivo') f.banco.value = ''; });
    },
    onSubmit: async f => {
      const body = { unidad_id: +f.unidad.value, monto_cents: pesosDe(f, 'monto'), fecha: val(f, 'fecha'), metodo: f.metodo.value, referencia: val(f, 'referencia') || null,
        cuenta_banco_id: f.banco.value ? +f.banco.value : null, notas: val(f, 'notas') || null, idem_key: key, confirmar_duplicado: confirmarDup };
      try {
        const r = await capi('/pagos', { method: 'POST', body });
        invalidar();
        toast(r.repetido ? 'Ese pago ya estaba registrado; no se duplicó.' : `Pago aplicado · recibo R-${r.folio}${r.saldo_favor ? ` · ${pesos(r.saldo_favor)} a favor` : ''}`);
        refrescarContadores(); onOk?.(r);
      } catch (e) {
        if (e.code === 'POSIBLE_DUPLICADO') { confirmarDup = true; throw new Error(`${e.message} Si es un pago distinto, presione de nuevo «Registrar y aplicar».`); }
        throw e;
      }
    },
  });
}

// ---------- Documentos imprimibles ----------
const encabezado = (c, titulo, derecha) => html`<header class="doc-head">
  <div><div class="brand">${raw(LOGO)}<div><b>${c.nombre}</b><small>${c.razon_social || ''}${c.rfc ? ` · RFC ${c.rfc}` : ''}</small></div></div><p class="org">${c.direccion || ''}</p></div>
  <div class="right"><h2>${titulo}</h2><div class="org">${derecha}</div></div></header>`;

export function docEstadoCuenta(d) {
  const prop = d.personas?.filter(p => p.rol === 'propietario').map(p => p.nombre).join(', ') || d.propietario || '—';
  const unidad = d.unidad;
  return html`<article class="doc">
    ${encabezado(d.condominio, 'Estado de cuenta', html`Del ${fecha(d.desde)} al ${fecha(d.hasta)}<br>Emitido ${fecha(hoy())}`)}
    <div class="doc-meta">
      <div><span>Unidad</span><b>${unidad.clave}</b></div><div><span>Propietario</span><b>${prop}</b></div>
      <div><span>Referencia de pago</span><b>${unidad.referencia}</b></div><div><span>Saldo al ${fecha(d.hasta)}</span><b class="${d.saldo_final > 0 ? 'neg-t' : ''}">${pesos(d.saldo_final)}</b></div>
    </div>
    ${tabla([
      { t: 'Fecha', k: r => fecha(r.fecha) }, { t: 'Concepto', k: r => html`${r.concepto}${r.recibo ? html`<span class="sub-t">Recibo R-${r.recibo}</span>` : ''}` },
      { t: 'Cargos', num: true, k: r => r.cargo ? pesos(r.cargo) : '' }, { t: 'Abonos', num: true, k: r => r.abono ? pesos(r.abono) : '' }, { t: 'Saldo', num: true, k: r => pesos(r.saldo) },
    ], [{ fecha: d.desde, concepto: 'Saldo anterior', cargo: 0, abono: 0, saldo: d.saldo_inicial }, ...d.movimientos], { pie: ['Totales', '', pesos(d.cargos), pesos(d.abonos), pesos(d.saldo_final)] })}
    ${d.pendientes?.length ? html`<h3>Cargos pendientes de pago</h3>${tabla([{ t: 'Concepto', k: r => r.concepto }, { t: 'Vence', k: r => fecha(r.vencimiento) }, { t: 'Saldo', num: true, k: r => pesos(r.saldo_cents) }], d.pendientes)}` : ''}
    <footer class="doc-foot"><span>${d.bancos?.length ? html`Pague por transferencia a ${d.bancos.map(b => `${b.banco} ${b.nombre} CLABE ${b.clabe_mask || ''}`).join(' · ')} con la referencia <b>${unidad.referencia}</b>.` : ''}</span><span>Indiviso CMS</span></footer>
  </article>`;
}

export function docRecibo(r) {
  const p = r.pago;
  return html`<article class="doc">
    ${encabezado(r.condominio, `Recibo R-${p.folio}`, html`${fecha(p.fecha)}${p.estado === 'cancelado' ? html`<br><b class="neg-t">CANCELADO</b>` : ''}`)}
    <div class="doc-meta"><div><span>Unidad</span><b>${p.clave}</b></div><div><span>Recibimos de</span><b>${r.propietario || '—'}</b></div><div><span>Forma de pago</span><b>${METODOS[p.metodo]}${p.banco ? ` · ${p.banco}` : ''}</b></div><div><span>Importe</span><b class="big">${pesos(p.monto_cents)}</b></div></div>
    <h3>Aplicación del pago</h3>
    ${tabla([{ t: 'Concepto', k: a => html`${a.concepto}${a.revertida ? html` <span class="pill neutral">revertida</span>` : ''}` }, { t: 'Importe', num: true, k: a => pesos(a.monto_cents) }], r.aplicaciones, { vacio: 'Abonado íntegramente como saldo a favor.' })}
    ${p.referencia ? html`<p class="small muted">Referencia bancaria: ${p.referencia}</p>` : ''}
    <footer class="doc-foot"><span>Sello de integridad ${r.sello}</span><span>Indiviso CMS</span></footer>
  </article>`;
}

export function docConstancia(c) {
  const adeudo = c.tipo === 'adeudo';
  return html`<article class="doc">
    ${encabezado(c.condominio, adeudo ? 'Constancia de adeudo' : 'Constancia de no adeudo', html`Folio ${c.folio}<br>${fecha(c.fecha)}`)}
    <p>${adeudo ? html`La administración del condominio hace constar que la unidad <b>${c.unidad.clave}</b>, a nombre de <b>${c.propietario || '—'}</b>, presenta al ${fecha(c.fecha)} un adeudo total de <b>${pesos(c.adeudo)}</b>, del cual <b>${pesos(c.vencido)}</b> se encuentra vencido, integrado como sigue:`
      : html`La administración del condominio hace constar que la unidad <b>${c.unidad.clave}</b>, a nombre de <b>${c.propietario || '—'}</b>, se encuentra <b>al corriente</b> en el pago de sus cuotas de mantenimiento y no registra adeudos al ${fecha(c.fecha)}.${c.saldo_favor ? ` Registra un saldo a favor de ${pesos(c.saldo_favor)}.` : ''}`}</p>
    ${adeudo ? tabla([{ t: 'Concepto', k: r => r.concepto }, { t: 'Vencimiento', k: r => fecha(r.vencimiento) }, { t: 'Saldo', num: true, k: r => pesos(r.saldo_cents) }], c.detalle, { pie: ['Total', '', pesos(c.adeudo)] }) : ''}
    <p class="small muted">${adeudo ? 'Conforme a la legislación de propiedad en condominio aplicable, el estado de liquidación de adeudos firmado por la administración y el comité de vigilancia puede constituir título para su cobro.' : 'Se expide a solicitud del interesado para los fines que convengan.'}</p>
    <div class="firma"><div>Administración</div><div>Comité de vigilancia</div></div>
    <footer class="doc-foot"><span>Sello de integridad ${c.sello}</span><span>Indiviso CMS</span></footer>
  </article>`;
}

export async function imprimirRecibo(id) { imprimir(docRecibo(await capi(`/pagos/${id}/recibo`))); }
export async function imprimirConstancia(uid) { imprimir(docConstancia(await capi(`/constancia/${uid}`))); }

export async function subirArchivo(file) {
  const base64 = await leerArchivo(file);
  return capi('/archivos', { method: 'POST', body: { nombre: file.name, base64 } });
}

export async function pedirMotivo(titulo, texto, label = 'Confirmar', danger = true) { return confirmar(titulo, texto, { label, danger, motivo: true }); }
export { mesNombre, m };
