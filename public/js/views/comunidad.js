// Comunidad: avisos, calendario, documentos, encuestas, teléfonos útiles y cosas perdidas.
// La administración y el comité publican; los residentes consultan y votan (un voto por unidad).
import { S, capi, html, raw, mount, $, fecha, fechaHora, hoy, puede, tabla, pill, toast, dialogo, val, cargando, tabs, descargar, barra, pct, confirmar } from '../ui.js';
import { subirArchivo, unidades } from './comun.js';

const SECCIONES = [['avisos', 'Avisos', 'aviso'], ['calendario', 'Calendario', 'evento'], ['documentos', 'Documentos', 'documento'], ['encuestas', 'Encuestas'], ['telefonos', 'Teléfonos útiles', 'telefono'], ['perdidos', 'Cosas perdidas', 'perdido']];
const NUEVO = { aviso: 'Publicar aviso', evento: 'Agregar evento', documento: 'Subir documento', telefono: 'Agregar teléfono', perdido: 'Registrar objeto' };
const CATS_DOC = ['Reglamento', 'Actas de asamblea', 'Estados financieros', 'Contratos', 'Pólizas de seguro', 'Otros'];

export async function render(el, ctx) {
  const sub = (ctx.params[0] || 'avisos').split('?')[0];
  const sec = SECCIONES.find(s => s[0] === sub) || SECCIONES[0];
  const pub = puede('comunicar');
  const c = S.condos.find(x => x.id === S.cid);
  mount(el, html`<div class="title-row"><div><h1>Comunidad</h1><p class="sub">${pub ? 'Lo que publique aquí lo ven los residentes en su portal (salvo lo marcado como interno).' : `Avisos, calendario, documentos y votaciones de ${c?.nombre || 'su condominio'}.`}</p></div>
      <div class="actions">${pub && sec[0] === 'encuestas' ? html`<button class="btn primary" data-action="nuevaEncuesta">Nueva encuesta</button>` : pub ? html`<button class="btn primary" data-action="nuevo" data-tipo="${sec[2]}">${NUEVO[sec[2]]}</button>` : ''}</div></div>
    ${tabs(SECCIONES.map(([k, l]) => [k, l]), sec[0], ctx.base)}<div id="cm-body"></div>`);
  const body = $('#cm-body', el);
  cargando(body);
  ctx.acciones({ nuevo: d => editar({ tipo: d.tipo }, ctx), nuevaEncuesta: () => nuevaEncuesta(ctx) });
  if (sec[0] === 'encuestas') return encuestas(body, ctx);
  const rows = await capi(`/comunidad?tipo=${sec[2]}`);
  ({ aviso: avisos, evento: calendario, documento: documentos, telefono: telefonos, perdido: perdidos })[sec[2]](body, rows, ctx);
  ctx.acciones({
    editar: d => editar(rows.find(r => r.id === +d.id), ctx),
    archivar: async d => { const r = rows.find(x => x.id === +d.id); if (!await confirmar('Archivar', `«${r.titulo}» dejará de mostrarse a los residentes.`, { label: 'Archivar', danger: true })) return; await guardar(r, { estado: 'archivado' }); toast('Archivado.'); ctx.recargar(); },
    entregado: async d => { const r = rows.find(x => x.id === +d.id); await guardar(r, { estado: 'entregado' }); toast('Marcado como entregado.'); ctx.recargar(); },
    fijar: async d => { const r = rows.find(x => x.id === +d.id); await guardar(r, { fijado: !r.fijado }); ctx.recargar(); },
    bajar: d => { const r = rows.find(x => x.id === +d.id); return descargar(`/api/c/${S.cid}/archivos/${r.archivo_id}`, r.archivo_nombre || 'documento.pdf'); },
  });
}

const cuerpoDe = r => ({ titulo: r.titulo, cuerpo: r.cuerpo, categoria: r.categoria, fecha: r.fecha, hora: r.hora, lugar: r.lugar, telefono: r.telefono, archivo_id: r.archivo_id, fijado: !!r.fijado, publico: !!r.publico, estado: r.estado });
const guardar = (r, cambios) => capi(`/comunidad/${r.id}`, { method: 'PUT', body: { ...cuerpoDe(r), ...cambios } });
const acciones = r => puede('comunicar') ? html`<span class="row-actions"><button class="link" data-action="editar" data-id="${r.id}">Editar</button><button class="link neg" data-action="archivar" data-id="${r.id}">Archivar</button></span>` : '';
const interno = r => r.publico ? '' : html` <span class="pill neutral">interno</span>`;

function avisos(el, rows) {
  mount(el, rows.length ? html`<div class="avisos">${rows.map(r => html`<article class="panel aviso ${r.fijado ? 'fijado' : ''}">
      <header><div><h2>${r.titulo}</h2><p class="meta">${fechaHora(r.created_at)}${r.autor ? ` · ${r.autor}` : ''}${r.categoria ? ` · ${r.categoria}` : ''}</p></div>
        <div class="row-actions">${r.fijado ? pill(['Fijado', 'warn']) : ''}${interno(r)}${puede('comunicar') ? html`<button class="link" data-action="fijar" data-id="${r.id}">${r.fijado ? 'Desfijar' : 'Fijar'}</button>` : ''}${acciones(r)}</div></header>
      <p class="texto">${r.cuerpo || ''}</p></article>`)}</div>` : html`<section class="panel empty-state">No hay avisos publicados.</section>`);
}

function calendario(el, rows) {
  const prox = rows.filter(r => r.fecha >= hoy()), pas = rows.filter(r => r.fecha < hoy()).reverse();
  const cols = [{ t: 'Fecha', k: r => html`<b>${fecha(r.fecha)}</b><span class="sub-t">${r.hora || ''}</span>`, cls: 'nowrap' }, { t: 'Evento', k: r => html`${r.titulo}${interno(r)}<span class="sub-t">${r.cuerpo || ''}</span>` }, { t: 'Lugar', k: r => r.lugar || html`<span class="faint">—</span>` }, { t: '', k: acciones }];
  mount(el, html`<section class="panel flush"><header><h2>Próximos eventos</h2><span class="meta">Asambleas, mantenimientos programados, cortes de servicio y eventos sociales</span></header>${tabla(cols, prox, { vacio: 'No hay eventos próximos.' })}</section>
    ${pas.length ? html`<section class="panel flush top-gap"><header><h2>Eventos pasados</h2></header>${tabla(cols, pas.slice(0, 30))}</section>` : ''}`);
}

function documentos(el, rows) {
  mount(el, html`<section class="panel flush"><header><h2>${rows.length} documentos</h2><span class="meta">Reglamento, actas, estados financieros y contratos</span></header>
    ${tabla([{ t: 'Documento', k: r => html`<b>${r.titulo}</b>${interno(r)}<span class="sub-t">${r.cuerpo || ''}</span>` }, { t: 'Categoría', k: r => r.categoria || '—', cls: 'hide-m' }, { t: 'Publicado', k: r => fechaHora(r.created_at), cls: 'hide-m nowrap' },
      { t: '', k: r => html`<span class="row-actions">${r.archivo_id ? html`<button class="btn sm" data-action="bajar" data-id="${r.id}">Descargar</button>` : ''}${acciones(r)}</span>` }], rows, { vacio: 'No hay documentos publicados.' })}</section>`);
}

function telefonos(el, rows) {
  mount(el, html`<section class="panel flush"><header><h2>Teléfonos y sitios útiles</h2></header>
    ${tabla([{ t: 'Nombre', k: r => html`<b>${r.titulo}</b>${interno(r)}<span class="sub-t">${r.categoria || ''}</span>` }, { t: 'Teléfono', k: r => html`<a class="link" href="tel:${String(r.telefono || '').replace(/[^\d+]/g, '')}">${r.telefono}</a>`, cls: 'nowrap' },
      { t: 'Detalle', k: r => r.cuerpo || html`<span class="faint">—</span>`, cls: 'hide-m' }, { t: '', k: acciones }], rows, { vacio: 'Sin teléfonos registrados.' })}</section>`);
}

function perdidos(el, rows) {
  mount(el, html`<section class="panel flush"><header><h2>Objetos encontrados</h2><span class="meta">Pregunte en administración o caseta para recogerlos</span></header>
    ${tabla([{ t: 'Fecha', k: r => fecha(r.fecha), cls: 'nowrap' }, { t: 'Objeto', k: r => html`<b>${r.titulo}</b>${interno(r)}<span class="sub-t">${r.cuerpo || ''}</span>` }, { t: 'Dónde se encontró', k: r => r.lugar || '—', cls: 'hide-m' },
      { t: 'Estado', k: r => pill(r.estado === 'entregado' ? ['Entregado', 'pos'] : ['En resguardo', 'warn']) },
      { t: '', k: r => puede('comunicar') ? html`<span class="row-actions">${r.estado === 'vigente' ? html`<button class="link" data-action="entregado" data-id="${r.id}">Entregado</button>` : ''}${acciones(r)}</span>` : '' }], rows, { vacio: 'No hay objetos registrados.' })}</section>`);
}

function editar(r, ctx) {
  const t = r.tipo, nuevo = !r.id;
  const titulo = { aviso: 'Título', evento: 'Evento', documento: 'Nombre del documento', telefono: 'Nombre o servicio', perdido: 'Objeto' }[t];
  let archivo = r.archivo_id || null;
  dialogo({
    titulo: nuevo ? NUEVO[t] : 'Editar publicación', ancho: t === 'aviso' ? 'wide' : '',
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>${titulo}</span><input name="titulo" value="${r.titulo || ''}" required maxlength="160"></label>
      ${t === 'evento' || t === 'perdido' ? html`<label class="field"><span>Fecha</span><input type="date" name="fecha" value="${r.fecha || hoy()}" ${t === 'evento' ? raw('required') : ''}></label>` : ''}
      ${t === 'evento' ? html`<label class="field"><span>Hora</span><input type="time" name="hora" value="${r.hora || ''}"></label>` : ''}
      ${t === 'evento' || t === 'perdido' ? html`<label class="field ${t === 'perdido' ? '' : 'full'}"><span>${t === 'perdido' ? 'Dónde se encontró' : 'Lugar'}</span><input name="lugar" value="${r.lugar || ''}" maxlength="120"></label>` : ''}
      ${t === 'telefono' ? html`<label class="field"><span>Teléfono</span><input name="telefono" value="${r.telefono || ''}" required maxlength="40"></label>` : ''}
      ${t === 'documento' ? html`<label class="field"><span>Categoría</span><select name="categoria">${CATS_DOC.map(x => html`<option ${r.categoria === x ? raw('selected') : ''}>${x}</option>`)}</select></label>`
        : t === 'aviso' || t === 'telefono' ? html`<label class="field"><span>Categoría <span class="hint">· opcional</span></span><input name="categoria" value="${r.categoria || ''}" maxlength="60" placeholder="${t === 'aviso' ? 'Mantenimiento, seguridad, asamblea…' : 'Emergencias, servicios…'}"></label>` : ''}
      ${t === 'documento' ? html`<label class="field full"><span>Archivo (PDF o imagen, hasta 5 MB)${r.archivo_nombre ? ` · actual: ${r.archivo_nombre}` : ''}</span><input type="file" name="archivo" accept=".pdf,.png,.jpg,.jpeg" ${nuevo ? raw('required') : ''}></label>` : ''}
      <label class="field full"><span>${t === 'aviso' ? 'Mensaje' : 'Descripción'} ${t === 'aviso' ? '' : html`<span class="hint">· opcional</span>`}</span><textarea name="cuerpo" rows="${t === 'aviso' ? 8 : 3}" maxlength="4000" ${t === 'aviso' ? raw('required') : ''}>${r.cuerpo || ''}</textarea></label>
      <label class="check full"><input type="checkbox" name="publico" ${r.publico === 0 ? '' : raw('checked')}><span>Visible para los residentes en su portal</span></label>
      ${t === 'aviso' ? html`<label class="check full"><input type="checkbox" name="fijado" ${r.fijado ? raw('checked') : ''}><span>Fijar arriba de los demás avisos</span></label>` : ''}</div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: nuevo ? 'Publicar' : 'Guardar', primary: true }],
    onSubmit: async f => {
      if (!val(f, 'titulo')) throw new Error('Escriba el título.');
      if (f.archivo?.files[0]) archivo = (await subirArchivo(f.archivo.files[0])).id;
      const body = { titulo: val(f, 'titulo'), cuerpo: val(f, 'cuerpo') || null, categoria: f.categoria ? (f.categoria.value || null) : r.categoria || null, fecha: f.fecha ? val(f, 'fecha') || null : r.fecha || null,
        hora: f.hora ? val(f, 'hora') || null : r.hora || null, lugar: f.lugar ? val(f, 'lugar') || null : r.lugar || null, telefono: f.telefono ? val(f, 'telefono') || null : r.telefono || null,
        archivo_id: archivo, publico: f.publico.checked, fijado: f.fijado ? f.fijado.checked : !!r.fijado, estado: r.estado || 'vigente' };
      if (nuevo) await capi('/comunidad', { method: 'POST', body: { tipo: t, ...body } }); else await capi(`/comunidad/${r.id}`, { method: 'PUT', body });
      toast(nuevo ? 'Publicado.' : 'Guardado.'); ctx.recargar();
    },
  });
}

async function encuestas(el, ctx) {
  const res = S.rol === 'residente', pub = puede('comunicar');
  const [rows, mis] = await Promise.all([capi('/encuestas'), res ? capi('/mi').then(d => d.unidades.map(u => u.unidad)) : Promise.resolve([])]);
  const tarjeta = e => {
    const r = e.resultados, pond = !!e.ponderada;
    const tot = pond ? (r?.indiviso_votado_ppm || 0) : (r?.emitidos || 0);
    const sinVotar = mis.filter(u => !e.mis_votos.some(v => v.unidad_id === u.id));
    return html`<article class="panel encuesta">
      <header><div><h2>${e.pregunta}</h2><p class="meta">${e.estado === 'abierta' ? `Abierta hasta el ${fecha(e.cierra)}` : `Cerrada · ${fecha(e.cierra)}`}${pond ? ' · resultados por porcentaje de indiviso' : ' · un voto por unidad'}</p></div>
        <div class="row-actions">${pill(e.estado === 'abierta' ? ['Abierta', 'pos'] : ['Cerrada', 'neutral'])}${pub && e.estado === 'abierta' ? html`<button class="link" data-action="votoAdmin" data-id="${e.id}">Registrar voto</button><button class="link neg" data-action="cerrar" data-id="${e.id}">Cerrar</button>` : ''}</div></header>
      ${e.descripcion ? html`<p class="texto">${e.descripcion}</p>` : ''}
      ${r ? html`<ul class="resultados">${e.opciones.map(o => { const v = pond ? o.indiviso_ppm : o.votos; const p = tot ? v / tot : 0;
          return html`<li><div class="hbar"><span>${o.texto}</span><span class="num">${pct(p, 0)} · ${o.votos} ${o.votos === 1 ? 'voto' : 'votos'}</span>${barra(p)}</div></li>`; })}</ul>
        <p class="small muted">Participación: ${r.emitidos} de ${r.unidades} unidades (${pct(r.participacion, 0)})${pond ? ` · ${(r.indiviso_votado_ppm / 10000).toFixed(2)}% del indiviso` : ''}.</p>` : html`<p class="small muted">Los resultados se muestran al votar o al cerrar la encuesta.</p>`}
      ${res && e.mis_votos.length ? html`<p class="note pos">Su voto: ${e.mis_votos.map(v => `${mis.find(u => u.id === v.unidad_id)?.clave || ''} · ${v.texto}`).join(' — ')}</p>` : ''}
      ${res && e.estado === 'abierta' && sinVotar.length ? html`<form class="votar" data-votar="${e.id}">
        ${sinVotar.length > 1 ? html`<label class="field"><span>Unidad</span><select name="unidad">${sinVotar.map(u => html`<option value="${u.id}">${u.clave}</option>`)}</select></label>` : html`<input type="hidden" name="unidad" value="${sinVotar[0].id}">`}
        <fieldset class="field"><span>Su voto${sinVotar.length === 1 ? ` · unidad ${sinVotar[0].clave}` : ''}</span>${e.opciones.map((o, i) => html`<label class="check"><input type="radio" name="opcion" value="${o.id}" ${i === 0 ? raw('required') : ''}><span>${o.texto}</span></label>`)}</fieldset>
        <button class="btn primary">Votar</button><p class="small muted">El voto es uno por unidad y no se puede cambiar.</p></form>` : ''}
    </article>`;
  };
  mount(el, rows.length ? html`<div class="avisos">${rows.map(tarjeta)}</div>` : html`<section class="panel empty-state">No hay encuestas${pub ? '. Cree una para consultar a los condóminos.' : '.'}</section>`);
  for (const f of el.querySelectorAll('form[data-votar]')) f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const op = f.querySelector('input[name=opcion]:checked'); if (!op) return toast('Elija una opción.', 'error');
    try { await capi(`/encuestas/${f.dataset.votar}/votar`, { method: 'POST', body: { opcion_id: +op.value, unidad_id: +f.unidad.value } }); toast('Voto registrado.'); ctx.recargar(); }
    catch (e) { toast(e.message, 'error'); }
  });
  ctx.acciones({
    cerrar: async d => { if (!await confirmar('Cerrar encuesta', 'Ya no se recibirán votos y los resultados quedarán visibles para todos.', { label: 'Cerrar votación' })) return; await capi(`/encuestas/${d.id}/cerrar`, { method: 'POST', body: {} }); toast('Encuesta cerrada.'); ctx.recargar(); },
    votoAdmin: async d => {
      const e = rows.find(x => x.id === +d.id), us = (await unidades()).filter(u => u.activo);
      dialogo({
        titulo: 'Registrar voto de una unidad', cuerpo: html`<p class="lead">Para votos recibidos en asamblea o por escrito. Queda en la bitácora con su usuario.</p>
          <label class="field"><span>Unidad</span><select name="unidad">${us.map(u => html`<option value="${u.id}">${u.clave} · ${u.propietario || 'sin propietario'}</option>`)}</select></label>
          <label class="field"><span>Opción</span><select name="opcion">${e.opciones.map(o => html`<option value="${o.id}">${o.texto}</option>`)}</select></label>`,
        acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Registrar voto', primary: true }],
        onSubmit: async f => { await capi(`/encuestas/${e.id}/votar`, { method: 'POST', body: { opcion_id: +f.opcion.value, unidad_id: +f.unidad.value } }); toast('Voto registrado.'); ctx.recargar(); },
      });
    },
  });
}

function nuevaEncuesta(ctx) {
  const cierre = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })();
  dialogo({
    titulo: 'Nueva encuesta', ancho: 'wide',
    cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Pregunta</span><input name="pregunta" required maxlength="200" placeholder="¿Aprueba cambiar el horario de la alberca?"></label>
      <label class="field full"><span>Detalle <span class="hint">· opcional</span></span><textarea name="descripcion" rows="3" maxlength="2000"></textarea></label>
      <label class="field full"><span>Opciones <span class="hint">· una por renglón, de 2 a 12</span></span><textarea name="opciones" rows="4" required>Sí\nNo\nMe abstengo</textarea></label>
      <label class="field"><span>Cierra el</span><input type="date" name="cierra" value="${cierre}" min="${hoy()}" required></label>
      <label class="check"><input type="checkbox" name="ponderada"><span>Contar los resultados por porcentaje de indiviso (como en asamblea)</span></label></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Publicar encuesta', primary: true }],
    onSubmit: async f => {
      await capi('/encuestas', { method: 'POST', body: { pregunta: val(f, 'pregunta'), descripcion: val(f, 'descripcion') || null, cierra: val(f, 'cierra'), ponderada: f.ponderada.checked, opciones: f.opciones.value.split('\n').map(x => x.trim()).filter(Boolean) } });
      toast('Encuesta publicada.'); location.hash = `#/c/${S.cid}/comunidad/encuestas`; ctx.recargar();
    },
  });
}
