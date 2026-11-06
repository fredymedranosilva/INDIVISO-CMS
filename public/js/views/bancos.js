// Bancos y conciliación: importar el estado de cuenta, conciliar contra pagos y egresos.
import { S, capi, html, raw, mount, pesos, fecha, puede, tabla, pill, toast, dialogo, val, cargando, parsePesos, ICON } from '../ui.js';
import { unidades, opcionesUnidad, invalidar } from './comun.js';
import { refrescarContadores } from '../app.js';

export async function render(el, ctx) {
  const [first, qs] = (ctx.params[0] || '').split('?');
  const q = new URLSearchParams(qs || '');
  cargando(el);
  const bs = await capi('/bancos');
  const bid = +first || bs[0]?.id;
  const b = bs.find(x => x.id === bid);
  const pend = q.get('todos') !== '1';
  const movs = b ? await capi(`/bancos/${b.id}/movimientos${pend ? '?estado=pendientes' : ''}`) : [];
  mount(el, html`
    <div class="title-row"><div><h1>Bancos y conciliación</h1><p class="sub">Importe el estado de cuenta en CSV: los movimientos repetidos se descartan solos y los depósitos se cruzan con los pagos por importe, fecha y referencia.</p></div>
      <div class="actions"><a class="btn" href="#/c/${S.cid}/reportes/bancos">${raw(ICON.pdf)}<span>Saldos bancarios</span></a><a class="btn" href="#/c/${S.cid}/reportes/conciliacion">${raw(ICON.pdf)}<span>Conciliación</span></a>${puede('config') ? html`<button class="btn" data-action="cuenta">Nueva cuenta</button>` : ''}${b && puede('capturar') ? html`<button class="btn" data-action="auto">Conciliar automáticamente</button><button class="btn primary" data-action="importar">Importar estado de cuenta</button>` : ''}</div></div>
    <div class="grid top">
      ${bs.map(x => html`<a class="panel c4 bank-card ${x.id === bid ? 'sel' : ''}" href="#/c/${S.cid}/bancos/${x.id}">
        <header><h2>${x.banco} · ${x.nombre}</h2><span class="meta">${x.numero_mask || ''}${x.fondo === 'reserva' ? ' · reserva' : ''}</span></header>
        <div class="kpis"><div class="kpi"><p class="label">Saldo en libros</p><p class="kpi-value md">${pesos(x.saldo_cents)}</p></div>
          <div class="kpi"><p class="label">Según estado importado</p><p class="kpi-value md ${x.ultimo_mov ? '' : 'zero'}">${x.ultimo_mov ? pesos(x.saldo_estado) : '—'}</p><p class="sub">${x.ultimo_mov ? `al ${fecha(x.ultimo_mov)}` : 'sin importar'}</p></div></div>
        <p class="meta top-gap">${x.sin_conciliar ? html`<b class="neg-t">${x.sin_conciliar}</b> movimientos sin conciliar` : 'Todo conciliado'}</p></a>`)}
      ${bs.length ? '' : html`<section class="panel c12 empty-state">No hay cuentas bancarias registradas.</section>`}
    </div>
    ${b ? html`<section class="panel flush top-gap">
      <header><h2>Movimientos ${pend ? 'pendientes' : ''} · ${b.banco} ${b.nombre}</h2><a class="link" href="#/c/${S.cid}/bancos/${b.id}?todos=${pend ? 1 : 0}">${pend ? 'Ver todos' : 'Ver solo pendientes'}</a></header>
      ${tabla([
        { t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' },
        { t: 'Descripción', k: r => html`${r.descripcion || '—'}<span class="sub-t">${r.referencia || ''}</span>` },
        { t: 'Retiro', num: true, k: r => r.cargo_cents ? pesos(r.cargo_cents) : '' },
        { t: 'Depósito', num: true, k: r => r.abono_cents ? pesos(r.abono_cents) : '' },
        { t: 'Conciliación', k: r => r.conciliado_tipo ? html`${pill(['Conciliado', 'pos'])}<span class="sub-t">${r.detalle || (r.conciliado_tipo === 'otro' ? 'Sin documento (otro)' : '')}</span>` : r.sugerida ? html`<span class="pill warn">Referencia de ${r.sugerida.clave}</span>` : pill(['Pendiente', 'neutral']) },
        { t: '', k: r => puede('capturar') ? html`<span class="row-actions">${r.conciliado_tipo ? html`<button class="link" data-action="deshacer" data-id="${r.id}">Deshacer</button>`
          : html`<button class="link" data-action="conciliar" data-id="${r.id}">Conciliar</button>${r.abono_cents ? html`<button class="link" data-action="crearPago" data-id="${r.id}" data-u="${r.sugerida?.id || ''}" data-monto="${r.abono_cents}">Registrar pago</button>` : ''}`}</span>` : '' },
      ], movs, { vacio: pend ? 'Todo está conciliado.' : 'Aún no se ha importado ningún estado de cuenta.' })}</section>` : ''}`);
  ctx.acciones({
    cuenta: () => dialogo({
      titulo: 'Nueva cuenta bancaria', cuerpo: html`<div class="form-grid">
        <label class="field"><span>Banco</span><input name="banco" required maxlength="40"></label><label class="field"><span>Nombre</span><input name="nombre" required maxlength="60" placeholder="Operación"></label>
        <label class="field"><span>Número de cuenta</span><input name="numero" required maxlength="20"></label><label class="field"><span>CLABE</span><input name="clabe" maxlength="18"></label>
        <label class="field full"><span>Fondo</span><select name="fondo"><option value="operacion">Operación</option><option value="reserva">Fondo de reserva</option></select></label>
        <p class="note full">Por seguridad solo se guardan los últimos 4 dígitos. Se crea su cuenta contable automáticamente.</p></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Crear cuenta', primary: true }],
      onSubmit: async f => { await capi('/bancos', { method: 'POST', body: { banco: val(f, 'banco'), nombre: val(f, 'nombre'), numero: val(f, 'numero'), clabe: val(f, 'clabe') || null, fondo: f.fondo.value } }); invalidar(); toast('Cuenta creada.'); ctx.recargar(); },
    }),
    auto: async () => { const r = await capi(`/bancos/${b.id}/autoconciliar`, { method: 'POST', body: {} }); toast(`${r.conciliados} movimientos conciliados.`); refrescarContadores(); ctx.recargar(); },
    importar: () => importar(b, ctx),
    deshacer: async d => { await capi(`/banco-movs/${d.id}/conciliar`, { method: 'POST', body: { tipo: 'ninguno' } }); ctx.recargar(); },
    conciliar: async d => {
      const cands = await capi(`/banco-movs/${d.id}/candidatos`);
      dialogo({
        titulo: 'Conciliar movimiento', cuerpo: html`${cands.length ? html`<fieldset class="field"><span>Documentos con el mismo importe</span>${cands.map((c, i) => html`<label class="check"><input type="radio" name="doc" value="${c.tipo}:${c.id}" ${i === 0 ? raw('checked') : ''}><span>${c.descripcion} · ${fecha(c.fecha)} · ${pesos(c.monto)}</span></label>`)}</fieldset>` : html`<p class="lead">No hay pagos ni egresos con ese importe sin conciliar.</p>`}
          <label class="check"><input type="radio" name="doc" value="otro" ${cands.length ? '' : raw('checked')}><span>Marcar como conciliado sin documento (comisión, interés, traspaso)</span></label>`,
        acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Conciliar', primary: true }],
        onSubmit: async f => { const v = f.doc.value; const [tipo, id] = v.split(':'); await capi(`/banco-movs/${d.id}/conciliar`, { method: 'POST', body: { tipo, id: id ? +id : null } }); refrescarContadores(); ctx.recargar(); },
      });
    },
    crearPago: async d => {
      const us = await unidades();
      dialogo({
        titulo: 'Registrar pago desde el banco', cuerpo: html`<p class="lead">Depósito de <b>${pesos(+d.monto)}</b>. Se registrará el pago, se aplicará a los cargos más antiguos y quedará conciliado.</p>
          <label class="field"><span>Unidad que pagó</span><select name="u">${opcionesUnidad(us, +d.u || null)}</select></label>`,
        acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar y conciliar', primary: true }],
        onSubmit: async f => { const r = await capi(`/banco-movs/${d.id}/crear-pago`, { method: 'POST', body: { unidad_id: +f.u.value } }); invalidar(); toast(`Pago aplicado · recibo R-${r.folio}`); refrescarContadores(); ctx.recargar(); },
      });
    },
  });
}

// CSV: fecha, descripción, referencia, retiro (cargo), depósito (abono). Acepta DD/MM/AAAA o AAAA-MM-DD.
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => { const out = []; let cur = '', qd = false; for (const ch of l) { if (ch === '"') qd = !qd; else if (ch === sep && !qd) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
  const head = split(lines[0]).map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const idx = names => head.findIndex(h => names.some(n => h.includes(n)));
  const iF = idx(['fecha']), iD = idx(['descrip', 'concepto']), iR = idx(['referencia', 'rastreo', 'ref']), iC = idx(['cargo', 'retiro']), iA = idx(['abono', 'deposito']);
  if (iF < 0 || (iC < 0 && iA < 0)) throw new Error('El archivo debe tener encabezados: fecha, descripción, referencia, cargo/retiro, abono/depósito.');
  const filas = [], errores = [];
  lines.slice(1).forEach((l, n) => {
    const c = split(l);
    let f = c[iF] || '';
    const dmy = f.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) f = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    const imp = s => { const v = String(s || '').replace(/[$\s]/g, '').replace(/,/g, ''); return v ? parsePesos(v.replace('-', '')) : 0; };
    const cargo = iC >= 0 ? imp(c[iC]) : 0, abono = iA >= 0 ? imp(c[iA]) : 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || cargo == null || abono == null || (!cargo && !abono)) { errores.push(n + 2); return; }
    filas.push({ fecha: f, descripcion: (c[iD] || '').slice(0, 200), referencia: (iR >= 0 ? c[iR] : '').slice(0, 60) || null, cargo_cents: cargo, abono_cents: abono });
  });
  return { filas, errores };
}

function importar(b, ctx) {
  let parsed = null;
  dialogo({
    titulo: `Importar estado de cuenta · ${b.banco} ${b.nombre}`, ancho: 'wide',
    cuerpo: html`<label class="field"><span>Archivo CSV exportado de la banca en línea</span><input type="file" name="csv" accept=".csv,text/csv" required></label>
      <p class="note">Encabezados esperados: <b>fecha, descripción, referencia, cargo, abono</b>. Reimportar el mismo archivo no duplica movimientos.</p><div data-prev></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Importar', primary: true }],
    onOpen: (d, f) => f.csv.addEventListener('change', async () => {
      const prev = d.querySelector('[data-prev]');
      try {
        parsed = parseCsv(await f.csv.files[0].text());
        const dep = parsed.filas.reduce((a, x) => a + x.abono_cents, 0), ret = parsed.filas.reduce((a, x) => a + x.cargo_cents, 0);
        mount(prev, html`<p class="note ${parsed.errores.length ? 'warn' : 'pos'}">${parsed.filas.length} movimientos válidos · depósitos ${pesos(dep)} · retiros ${pesos(ret)}${parsed.errores.length ? ` · filas ignoradas: ${parsed.errores.slice(0, 12).join(', ')}` : ''}</p>`);
      } catch (e) { parsed = null; mount(prev, html`<p class="note neg">${e.message}</p>`); }
    }),
    onSubmit: async () => {
      if (!parsed?.filas.length) throw new Error('Seleccione un archivo con movimientos válidos.');
      const r = await capi(`/bancos/${b.id}/importar`, { method: 'POST', body: { filas: parsed.filas } });
      toast(`${r.nuevos} movimientos nuevos · ${r.repetidos} ya existían · ${r.conciliados} conciliados automáticamente`);
      refrescarContadores(); ctx.recargar();
    },
  });
}
