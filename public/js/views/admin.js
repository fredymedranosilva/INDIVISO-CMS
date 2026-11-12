// Administración general (superadministrador): estado del sistema, condominios, usuarios de todos los condominios y bitácora de seguridad.
import { S, api, html, raw, mount, $, fechaHora, tabla, pill, toast, dialogo, val, cargando, tabs, confirmar, entero, ICON } from '../ui.js';

const ROL = { admin: 'Administración', contador: 'Contabilidad', comite: 'Comité', residente: 'Residente' };
const mb = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

export async function render(el, ctx) {
  if (!S.me.superadmin) { mount(el, html`<div class="error-state">Solo el superadministrador tiene acceso a esta sección.</div>`); return; }
  const sub = (ctx.params[0] || 'estado').split('?')[0];
  mount(el, html`<div class="title-row"><div><h1>Administración general</h1><p class="sub">Todos los condominios y usuarios del sistema, su seguridad y sus respaldos.</p></div>
    <div class="actions"><button class="btn primary" data-action="nuevoCondo">${raw(ICON.mas)}<span>Nuevo condominio</span></button></div></div>
    ${tabs([['estado', 'Estado del sistema'], ['condominios', 'Condominios'], ['usuarios', 'Usuarios'], ['seguridad', 'Eventos de seguridad']], sub, '#/admin')}<div id="ad-body"></div>`);
  const body = $('#ad-body', el); cargando(body);
  ctx.acciones({ nuevoCondo: () => nuevoCondominio(ctx) });
  await ({ estado, condominios, usuarios, seguridad }[sub] || estado)(body, ctx);
}

function nuevoCondominio(ctx) {
  dialogo({ titulo: 'Nuevo condominio', cuerpo: html`<div class="form-grid">
      <label class="field full"><span>Nombre</span><input name="nombre" required maxlength="120"></label>
      <label class="field full"><span>Razón social <span class="hint">· opcional</span></span><input name="razon" maxlength="160"></label>
      <label class="field"><span>RFC <span class="hint">· opcional</span></span><input name="rfc" maxlength="13"></label>
      <label class="field"><span>Ciudad</span><input name="ciudad" maxlength="80"></label>
      <p class="note full">Se crea con su catálogo contable. Después dé acceso a su administrador desde Seguridad → Usuarios y roles.</p></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Crear condominio', primary: true }],
    onSubmit: async f => {
      const r = await api('/api/condominios', { method: 'POST', body: { nombre: val(f, 'nombre'), razon_social: val(f, 'razon') || null, rfc: val(f, 'rfc') || null, ciudad: val(f, 'ciudad') || null } });
      toast('Condominio creado.');
      location.hash = `#/c/${r.id}/config`; location.reload();
    } });
}

async function estado(el, ctx) {
  const e = await api('/api/admin/estado');
  ctx.acciones({ verificar: async () => { const r = await api('/api/admin/auditoria/verificar'); r.ok ? toast(`Cadena íntegra: ${r.registros} registros verificados.`) : toast(`Cadena rota en el registro ${r.roto_en}.`, 'error'); } });
  const alerta = (n, t) => n ? html`<span class="pill warn">${n} ${t}</span>` : pill(['En orden', 'pos']);
  mount(el, html`<section class="panel"><div class="kpis">
      <div class="kpi"><p class="label">Condominios activos</p><p class="kpi-value">${e.condominios}</p></div>
      <div class="kpi"><p class="label">Usuarios activos</p><p class="kpi-value">${e.usuarios}</p><p class="sub">${e.sesiones_activas} en línea ahora</p></div>
      <div class="kpi"><p class="label">Último respaldo</p><p class="kpi-value md">${e.respaldos.ultimo ? fechaHora(e.respaldos.ultimo.created_at) : 'Ninguno'}</p><p class="sub">${e.respaldos.n} respaldos cifrados</p></div>
      <div class="kpi"><p class="label">Base de datos</p><p class="kpi-value md">${mb(e.base_bytes)}</p><p class="sub">${entero(e.archivos.n)} adjuntos · ${mb(e.archivos.bytes)}</p></div></div></section>
    <div class="grid top top-gap"><section class="panel c6"><header><h2>Revisión de seguridad</h2></header><ul class="rows">
      <li><span class="t"><b>Conexión cifrada (HTTPS)</b><span>Obligatoria al publicar en internet</span></span><span class="v">${e.https ? pill(['Activa', 'pos']) : pill(['Local', 'neutral'])}</span></li>
      <li><span class="t"><b>Usuarios con acceso financiero sin 2FA</b><span>Pídales activar la verificación en dos pasos</span></span><span class="v">${alerta(e.sin_2fa, 'usuarios')}</span></li>
      <li><span class="t"><b>Cuentas bloqueadas ahora</b><span>Por intentos fallidos de acceso</span></span><span class="v">${alerta(e.cuentas_bloqueadas, 'cuentas')}</span></li>
      <li><span class="t"><b>Accesos fallidos (24 h)</b></span><span class="v">${alerta(e.accesos_fallidos_24h, 'intentos')}</span></li>
      <li><span class="t"><b>Accesos denegados (24 h)</b><span>Intentos de entrar a algo sin permiso</span></span><span class="v">${alerta(e.denegados_24h, 'eventos')}</span></li>
      <li><span class="t"><b>Bitácora encadenada</b><span>${entero(e.bitacora)} registros</span></span><span class="v"><button class="btn sm" data-action="verificar">Verificar cadena</button></span></li></ul></section>
    <section class="panel c6"><header><h2>Sistema</h2></header><ul class="rows">
      <li><span class="t">Versión</span><span class="v">Indiviso CMS ${e.version}</span></li><li><span class="t">Node.js</span><span class="v">${e.node}</span></li>
      <li><span class="t">En servicio desde</span><span class="v">${fechaHora(e.iniciado)}</span></li><li><span class="t">Carpeta de respaldos</span><span class="v small">${e.respaldos.carpeta}</span></li></ul>
      <p class="note top-gap">Copie periódicamente la carpeta de respaldos y las llaves (respaldo.key y secreto.key) a un lugar externo y seguro: sin las llaves los respaldos no se pueden abrir.</p></section></div>`);
}

async function condominios(el, ctx) {
  const rows = await api('/api/admin/condominios');
  mount(el, html`<section class="panel flush"><header><h2>${rows.length} condominios</h2></header>${tabla([
    { t: 'Condominio', k: c => html`<a class="link" href="#/c/${c.id}/tablero"><b>${c.nombre}</b></a><span class="sub-t">${[c.razon_social, c.rfc, c.ciudad].filter(Boolean).join(' · ')}</span>` },
    { t: 'Unidades', num: true, k: c => c.unidades }, { t: 'Usuarios', num: true, k: c => c.usuarios },
    { t: 'Última actividad', k: c => c.ultima_actividad ? fechaHora(c.ultima_actividad) : '—', cls: 'hide-m' },
    { t: 'Estado', k: c => pill(c.activo ? ['Activo', 'pos'] : ['Archivado', 'neutral']) },
    { t: '', k: c => html`<button class="link ${c.activo ? 'neg' : ''}" data-action="archivar" data-id="${c.id}" data-activo="${c.activo}" data-nombre="${c.nombre}">${c.activo ? 'Archivar' : 'Reactivar'}</button>` }], rows)}</section>`);
  ctx.acciones({ archivar: async d => {
    const activar = d.activo !== '1';
    if (!activar && !await confirmar('Archivar condominio', `${d.nombre} dejará de aparecer para sus usuarios. Sus datos se conservan y puede reactivarlo.`, { label: 'Archivar', danger: true })) return;
    await api(`/api/admin/condominios/${d.id}`, { method: 'PUT', body: { activo: activar } }); toast(activar ? 'Condominio reactivado.' : 'Condominio archivado.'); ctx.recargar();
  } });
}

async function usuarios(el, ctx) {
  const rows = await api('/api/admin/usuarios');
  mount(el, html`<section class="panel flush"><header><h2>${rows.length} usuarios</h2><span class="meta">Acceso por condominio, verificación en dos pasos y sesiones</span></header>${tabla([
    { t: 'Usuario', k: u => html`<b>${u.nombre}</b>${u.superadmin ? html` <span class="pill neutral">superadministrador</span>` : ''}<span class="sub-t">${u.email}</span>` },
    { t: 'Acceso', k: u => u.accesos.length ? html`${u.accesos.map(a => html`<span class="sub-t">${a.condominio} · ${ROL[a.rol]}</span>`)}` : html`<span class="faint">—</span>` },
    { t: 'Seguridad', k: u => html`${u.totp_activo ? pill(['2FA', 'pos']) : pill(['Sin 2FA', 'warn'])} ${u.bloqueado_hasta > Date.now() ? pill(['Bloqueada', 'neg']) : ''} ${u.debe_cambiar_pass ? pill(['Temporal', 'neutral']) : ''}<span class="sub-t">${u.sesiones} sesiones · último acceso ${u.ultimo_acceso ? fechaHora(u.ultimo_acceso) : '—'}</span>` },
    { t: 'Estado', k: u => pill(u.activo ? ['Activo', 'pos'] : ['Desactivado', 'neutral']) },
    { t: '', k: u => u.id === S.me.id ? html`<span class="faint">usted</span>` : html`<span class="row-actions">
      <button class="link" data-action="u" data-a="restablecer" data-id="${u.id}" data-n="${u.nombre}">Contraseña</button>
      ${u.totp_activo ? html`<button class="link" data-action="u" data-a="restablecer-2fa" data-id="${u.id}" data-n="${u.nombre}">Quitar 2FA</button>` : ''}
      ${u.bloqueado_hasta > Date.now() ? html`<button class="link" data-action="u" data-a="desbloquear" data-id="${u.id}" data-n="${u.nombre}">Desbloquear</button>` : ''}
      ${u.sesiones ? html`<button class="link" data-action="u" data-a="cerrar-sesiones" data-id="${u.id}" data-n="${u.nombre}">Cerrar sesiones</button>` : ''}
      <button class="link ${u.activo ? 'neg' : ''}" data-action="activo" data-id="${u.id}" data-activo="${u.activo}" data-n="${u.nombre}">${u.activo ? 'Desactivar' : 'Reactivar'}</button></span>` }], rows)}</section>`);
  const textos = { restablecer: 'Se generará una contraseña temporal (vence en 7 días) y se cerrarán sus sesiones.', 'restablecer-2fa': 'Podrá entrar solo con su contraseña y deberá activar la verificación de nuevo.', desbloquear: 'Podrá volver a intentar el acceso de inmediato.', 'cerrar-sesiones': 'Tendrá que volver a iniciar sesión en todos sus dispositivos.' };
  ctx.acciones({
    u: async d => {
      if (!await confirmar(`${d.n}`, textos[d.a], { label: 'Continuar', danger: d.a !== 'desbloquear' })) return;
      const r = await api(`/api/admin/usuarios/${d.id}/${d.a}`, { method: 'POST', body: {} });
      if (r.password_temporal) dialogo({ titulo: 'Contraseña temporal', cuerpo: html`<p class="lead">Entréguela a ${d.n} por un canal seguro. Se muestra <b>una sola vez</b> y deberá cambiarla al entrar.</p><p class="secret num">${r.password_temporal}</p>` });
      else toast('Listo.');
      ctx.recargar();
    },
    activo: async d => {
      const activar = d.activo !== '1';
      if (!activar && !await confirmar('Desactivar usuario', `${d.n} no podrá entrar a ningún condominio y sus sesiones se cerrarán.`, { label: 'Desactivar', danger: true })) return;
      await api(`/api/admin/usuarios/${d.id}`, { method: 'PUT', body: { activo: activar } }); toast(activar ? 'Usuario reactivado.' : 'Usuario desactivado.'); ctx.recargar();
    },
  });
}

async function seguridad(el) {
  const rows = await api('/api/admin/auditoria?seguridad=1&limit=300');
  mount(el, html`<section class="panel flush"><header><h2>Eventos de seguridad</h2><span class="meta">Accesos fallidos, bloqueos e intentos sin permiso en todo el sistema</span></header>${tabla([
    { t: 'Fecha', k: a => fechaHora(a.ts), cls: 'nowrap' }, { t: 'Evento', k: a => html`<b>${a.accion.replaceAll('_', ' ')}</b><span class="sub-t">${a.condominio || ''}</span>` },
    { t: 'Usuario', k: a => a.usuario || html`<span class="faint">${(() => { try { return JSON.parse(a.detalle || '{}').email || '—'; } catch { return '—'; } })()}</span>` },
    { t: 'Detalle', k: a => html`<span class="small muted">${(a.detalle || '').slice(0, 120)}</span>`, cls: 'hide-m' }, { t: 'IP', k: a => a.ip || '—' }], rows, { vacio: 'Sin eventos de seguridad.' })}</section>`);
}
