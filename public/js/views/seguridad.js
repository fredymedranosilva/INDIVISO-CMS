// Seguridad: mi cuenta (contraseña, 2FA, sesiones), usuarios y roles, bitácora encadenada y respaldos.
import { S, api, capi, html, raw, mount, $, fechaHora, puede, tabla, pill, toast, dialogo, val, cargando, tabs, confirmar, descargar } from '../ui.js';

function mostrarCodigos(codigos, ctx) {
  dialogo({ titulo: 'Guarde sus códigos de respaldo', cuerpo: html`<p class="lead">Cada código sirve <b>una sola vez</b> para entrar si pierde su teléfono. Guárdelos en un lugar seguro: no se volverán a mostrar.</p>
    <p class="secret num">${codigos.join('   ')}</p>`, acciones: [{ label: 'Ya los guardé', primary: true, value: 'ok' }], onSubmit: () => { toast('Verificación en dos pasos activa.'); ctx.recargar(); } });
}

const ROLES = { admin: 'Administración', contador: 'Contabilidad', comite: 'Comité de vigilancia', residente: 'Residente' };
const DESC_ROL = { admin: 'Todo, incluidos usuarios, cancelaciones y cierres.', contador: 'Captura cobros, egresos, conciliación y pólizas. No aprueba egresos ni cancela.', comite: 'Consulta todo, aprueba egresos y revisa la bitácora. No captura.', residente: 'Solo su estado de cuenta, sus recibos y reportar pagos.' };

export async function render(el, ctx) {
  const pedida = (ctx.params[0] || 'cuenta').split('?')[0];
  const items = [['cuenta', 'Mi cuenta']];
  if (puede('usuarios')) items.push(['usuarios', 'Usuarios y roles']);
  if (puede('auditoria')) items.push(['bitacora', 'Bitácora']);
  if (S.me.superadmin) items.push(['respaldos', 'Respaldos']);
  const sub = items.some(([k]) => k === pedida) ? pedida : 'cuenta'; // una pestaña sin permiso no se abre por URL
  mount(el, html`<div class="title-row"><div><h1>Seguridad</h1><p class="sub">Contraseñas con scrypt, verificación en dos pasos, sesiones de servidor con expiración, permisos por rol en cada operación y bitácora encadenada por hash.</p></div></div>
    ${tabs(items, sub, ctx.base)}<div id="sg-body"></div>`);
  const body = $('#sg-body', el); cargando(body);
  return ({ cuenta, usuarios, bitacora, respaldos }[sub] || cuenta)(body, ctx);
}

async function cuenta(el, ctx) {
  const ses = await api('/api/auth/sesiones');
  mount(el, html`<div class="grid top">
    <section class="panel c6"><header><h2>Verificación en dos pasos</h2>${pill(S.me.totp ? ['Activa', 'pos'] : ['Inactiva', 'warn'])}</header>
      <p class="lead small">${S.me.totp ? 'Al iniciar sesión se pide un código de su aplicación de autenticación además de la contraseña.' : 'Recomendada para todos los usuarios con acceso financiero. Use Google Authenticator, Authy, 1Password o similar.'}</p>
      ${S.me.totp ? html`<p class="small muted top-gap">Códigos de respaldo disponibles: <b>${S.me.codigos_respaldo ?? '—'}</b> de 10. Sirven para entrar si pierde el teléfono.</p>` : ''}
      <div class="actions top-gap"><button class="btn" data-action="${S.me.totp ? 'mfaOff' : 'mfaOn'}">${S.me.totp ? 'Desactivar' : 'Activar verificación en dos pasos'}</button>${S.me.totp ? html`<button class="btn ghost" data-action="codigos">Generar códigos nuevos</button>` : ''}</div></section>
    <section class="panel c6"><header><h2>Contraseña</h2></header>
      <p class="lead small">Mínimo 12 caracteres con tres tipos: minúsculas, mayúsculas, números o símbolos. Al cambiarla se cierran sus demás sesiones.</p>
      <button class="btn top-gap" data-action="pass">Cambiar contraseña</button></section>
    <section class="panel c12 flush"><header><h2>Sesiones activas</h2><span class="meta">Expiran tras 30 minutos sin actividad o 12 horas en total. <button class="link" data-action="otras">Cerrar las demás</button></span></header>
      ${tabla([{ t: 'Dispositivo', k: s => html`${s.ua?.slice(0, 80) || '—'}${s.actual ? html` <span class="pill pos">esta sesión</span>` : ''}` }, { t: 'IP', k: s => s.ip }, { t: 'Inicio', k: s => fechaHora(s.created_at) }, { t: 'Última actividad', k: s => fechaHora(s.last_seen) },
        { t: '', k: s => s.actual ? '' : html`<button class="link neg" data-action="revocar" data-id="${s.id}">Cerrar</button>` }], ses)}</section></div>`);
  ctx.acciones({
    codigos: () => dialogo({
      titulo: 'Códigos de respaldo nuevos', cuerpo: html`<p class="lead">Los códigos anteriores dejarán de servir.</p><label class="field"><span>Contraseña</span><input type="password" name="password" required></label><label class="field"><span>Código actual de la aplicación</span><input name="code" inputmode="numeric" maxlength="6" required></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Generar', primary: true }],
      onSubmit: async f => { const r = await api('/api/auth/totp/codigos', { method: 'POST', body: { password: f.password.value, code: val(f, 'code') } }); mostrarCodigos(r.codigos, ctx); },
    }),
    otras: async () => { const r = await api('/api/auth/sesiones/cerrar-otras', { method: 'POST', body: {} }); toast(`${r.cerradas} sesiones cerradas.`); ctx.recargar(); },
    revocar: async d => { await api(`/api/auth/sesiones/${d.id}/revocar`, { method: 'POST', body: {} }); toast('Sesión cerrada.'); ctx.recargar(); },
    pass: () => dialogo({
      titulo: 'Cambiar contraseña', cuerpo: html`<label class="field"><span>Contraseña actual</span><input type="password" name="actual" autocomplete="current-password" required></label>
        <label class="field"><span>Nueva contraseña</span><input type="password" name="nueva" autocomplete="new-password" minlength="12" required aria-describedby="pw-h"><span class="hint" id="pw-h">Mínimo 12 caracteres; combine al menos tres tipos de caracteres.</span></label>
        <label class="field"><span>Confirmar nueva contraseña</span><input type="password" name="conf" autocomplete="new-password" required></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Cambiar', primary: true }],
      onSubmit: async f => { if (f.nueva.value !== f.conf.value) throw new Error('Las contraseñas no coinciden.'); await api('/api/auth/password', { method: 'POST', body: { actual: f.actual.value, nueva: f.nueva.value } }); toast('Contraseña actualizada; sus otras sesiones se cerraron.'); },
    }),
    mfaOn: async () => {
      const r = await api('/api/auth/totp/iniciar', { method: 'POST', body: {} });
      dialogo({
        titulo: 'Activar verificación en dos pasos', cuerpo: html`<p class="lead">En su aplicación de autenticación agregue una cuenta con esta clave (o abra el enlace en el teléfono):</p>
          <p class="secret num">${r.secret.match(/.{1,4}/g).join(' ')}</p><p class="small"><a class="link" href="${r.uri}">Abrir en la aplicación</a></p>
          <label class="field"><span>Código de 6 dígitos que muestra la aplicación</span><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>`,
        acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Activar', primary: true }],
        onSubmit: async f => { const r2 = await api('/api/auth/totp/activar', { method: 'POST', body: { code: val(f, 'code') } }); S.me.totp = true; mostrarCodigos(r2.codigos, ctx); },
      });
    },
    mfaOff: () => dialogo({
      titulo: 'Desactivar verificación en dos pasos', cuerpo: html`<label class="field"><span>Contraseña</span><input type="password" name="password" required></label><label class="field"><span>Código actual</span><input name="code" inputmode="numeric" maxlength="6" required></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Desactivar', danger: true }],
      onSubmit: async f => { await api('/api/auth/totp/desactivar', { method: 'POST', body: { password: f.password.value, code: val(f, 'code') } }); S.me.totp = false; toast('Verificación en dos pasos desactivada.'); ctx.recargar(); },
    }),
  });
}

async function usuarios(el, ctx) {
  const [rows, personas] = await Promise.all([capi('/usuarios'), capi('/personas')]);
  mount(el, html`<div class="filters"><span class="spacer"></span><button class="btn primary" data-action="invitar">Dar acceso</button></div>
    <div class="grid top"><section class="panel c8 flush"><header><h2>${rows.length} usuarios con acceso</h2></header>
      ${tabla([{ t: 'Usuario', k: u => html`<b>${u.nombre}</b><span class="sub-t">${u.email}</span>` }, { t: 'Rol', k: u => html`${ROLES[u.rol]}${u.persona ? html`<span class="sub-t">${u.persona}</span>` : ''}` },
        { t: '2FA', k: u => u.totp_activo ? pill(['Activa', 'pos']) : pill(['No', 'neutral']) }, { t: 'Último acceso', k: u => fechaHora(u.ultimo_acceso), cls: 'hide-m' },
        { t: '', k: u => u.id === S.me.id ? html`<span class="faint">usted</span>` : html`<span class="row-actions"><button class="link" data-action="ua" data-a="restablecer" data-id="${u.id}" data-nombre="${u.nombre}">Contraseña</button>${u.totp_activo ? html`<button class="link" data-action="ua" data-a="restablecer-2fa" data-id="${u.id}" data-nombre="${u.nombre}">Quitar 2FA</button>` : ''}${u.bloqueado_hasta > Date.now() ? html`<button class="link" data-action="ua" data-a="desbloquear" data-id="${u.id}" data-nombre="${u.nombre}">Desbloquear</button>` : ''}<button class="link" data-action="rol" data-id="${u.id}" data-rol="${u.rol}" data-nombre="${u.nombre}">Cambiar rol</button><button class="link neg" data-action="revocar" data-id="${u.id}" data-nombre="${u.nombre}">Quitar acceso</button></span>` }], rows)}</section>
      <section class="panel c4"><header><h2>Roles</h2></header><ul class="rows">${Object.entries(ROLES).map(([k, l]) => html`<li><span class="t"><b>${l}</b><span>${DESC_ROL[k]}</span></span></li>`)}</ul>
        <p class="note top-gap">Segregación de funciones: quien captura un egreso nunca puede aprobarlo, sin importar su rol.</p></section></div>`);
  ctx.acciones({
    invitar: () => dialogo({
      titulo: 'Dar acceso a un usuario', cuerpo: html`<div class="form-grid"><label class="field full"><span>Nombre</span><input name="nombre" required maxlength="120"></label><label class="field full"><span>Correo</span><input name="email" type="email" required></label>
        <label class="field"><span>Rol</span><select name="rol">${Object.entries(ROLES).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label class="field"><span>Residente del padrón <span class="hint">· solo para rol residente</span></span><select name="persona"><option value="">—</option>${personas.map(p => html`<option value="${p.id}">${p.nombre} · ${p.unidades || ''}</option>`)}</select></label></div>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Dar acceso', primary: true }],
      onSubmit: async f => {
        const r = await capi('/usuarios', { method: 'POST', body: { nombre: val(f, 'nombre'), email: val(f, 'email'), rol: f.rol.value, persona_id: f.persona.value ? +f.persona.value : null } });
        if (r.password_temporal) dialogo({ titulo: 'Contraseña temporal', cuerpo: html`<p class="lead">Entréguela al usuario por un canal seguro. Se muestra <b>una sola vez</b>, vence en 7 días y deberá cambiarla al entrar.</p><p class="secret num">${r.password_temporal}</p>` });
        else toast('Acceso otorgado a un usuario existente.');
        ctx.recargar();
      },
    }),
    ua: async d => {
      if (!await confirmar(d.nombre, { restablecer: 'Se generará una contraseña temporal (vence en 7 días) y se cerrarán sus sesiones.', 'restablecer-2fa': 'Podrá entrar solo con su contraseña y deberá activar la verificación de nuevo.', desbloquear: 'Podrá volver a intentar el acceso.' }[d.a], { label: 'Continuar', danger: d.a !== 'desbloquear' })) return;
      const r = await capi(`/usuarios/${d.id}/${d.a}`, { method: 'POST', body: {} });
      if (r.password_temporal) dialogo({ titulo: 'Contraseña temporal', cuerpo: html`<p class="lead">Entréguela a ${d.nombre} por un canal seguro. Se muestra <b>una sola vez</b> y deberá cambiarla al entrar.</p><p class="secret num">${r.password_temporal}</p>` });
      else toast('Listo.');
      ctx.recargar();
    },
    rol: d => dialogo({
      titulo: `Rol de ${d.nombre}`, cuerpo: html`<label class="field"><span>Rol</span><select name="rol">${Object.entries(ROLES).map(([k, l]) => html`<option value="${k}" ${k === d.rol ? raw('selected') : ''}>${l}</option>`)}</select></label>`,
      acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Guardar', primary: true }],
      onSubmit: async f => { await capi(`/usuarios/${d.id}`, { method: 'PUT', body: { rol: f.rol.value, activo: true } }); toast('Rol actualizado.'); ctx.recargar(); },
    }),
    revocar: async d => { if (!await confirmar('Quitar acceso', `${d.nombre} ya no podrá entrar a este condominio. Si no tiene otro, sus sesiones se cierran de inmediato.`, { label: 'Quitar acceso', danger: true })) return; await capi(`/usuarios/${d.id}`, { method: 'PUT', body: { rol: 'admin', activo: false } }); ctx.recargar(); },
  });
}

async function bitacora(el, ctx) {
  const rows = await capi('/auditoria?limit=200');
  mount(el, html`<div class="filters"><p class="lead">Cada registro guarda el hash del anterior: cualquier alteración o borrado rompe la cadena y se detecta.</p><span class="spacer"></span><button class="btn" data-action="verificar">Verificar cadena</button></div>
    <section class="panel flush"><header><h2>Últimos ${rows.length} eventos</h2></header>
    ${tabla([{ t: 'Fecha', k: a => fechaHora(a.ts), cls: 'nowrap' }, { t: 'Usuario', k: a => a.usuario || 'Sistema' }, { t: 'Acción', k: a => html`<b>${a.accion.replaceAll('_', ' ')}</b><span class="sub-t">${a.entidad ? `${a.entidad} ${a.entidad_id ?? ''}` : ''}</span>` },
      { t: 'Detalle', k: a => html`<span class="small muted">${(a.detalle || '').slice(0, 140)}</span>`, cls: 'hide-m' }, { t: 'IP', k: a => a.ip || '—', cls: 'hide-m' }, { t: 'Hash', k: a => html`<span class="num small faint" title="${a.hash}">${a.hash.slice(0, 10)}</span>`, cls: 'hide-m' }], rows, { vacio: 'Sin eventos aún.' })}</section>`);
  ctx.acciones({ verificar: async () => { const r = await api('/api/admin/auditoria/verificar'); r.ok ? toast(`Cadena íntegra: ${r.registros} registros verificados.`) : toast(`¡Cadena rota en el registro ${r.roto_en}! Posible alteración.`, 'error'); } });
}

async function respaldos(el, ctx) {
  const rows = await api('/api/admin/respaldos');
  mount(el, html`<div class="filters"><p class="lead">Respaldos cifrados con AES-256-GCM cada 6 horas, antes de cada cierre y bajo demanda. Se conservan los últimos 90. Copie periódicamente la carpeta de respaldos y la llave a un lugar externo.</p><span class="spacer"></span><button class="btn primary" data-action="crear">Crear respaldo ahora</button></div>
    <section class="panel flush"><header><h2>${rows.length} respaldos</h2></header>
    ${tabla([{ t: 'Archivo', k: r => html`<span class="num">${r.archivo}</span><span class="sub-t">${r.motivo}</span>` }, { t: 'Creado', k: r => fechaHora(r.created_at) }, { t: 'Tamaño', num: true, k: r => `${(r.bytes / 1048576).toFixed(2)} MB` },
      { t: 'Verificado', k: r => r.verificado ? pill(['Restaurable', 'pos']) : pill(['Sin verificar', 'warn']) },
      { t: '', k: r => html`<span class="row-actions"><button class="link" data-action="verif" data-f="${r.archivo}">Verificar</button><button class="link" data-action="bajar" data-f="${r.archivo}">Descargar</button></span>` }], rows, { vacio: 'Aún no hay respaldos.' })}</section>`);
  ctx.acciones({
    crear: async () => { const r = await api('/api/admin/respaldos', { method: 'POST', body: {} }); toast(`Respaldo ${r.archivo} creado y verificado.`); ctx.recargar(); },
    verif: async d => { const r = await api(`/api/admin/respaldos/${encodeURIComponent(d.f)}/verificar`, { method: 'POST', body: {} }); r.ok ? toast('El respaldo se descifra y pasa la verificación de integridad.') : toast(`Respaldo dañado: ${r.error || 'falló la verificación'}`, 'error'); },
    bajar: d => descargar(`/api/admin/respaldos/${encodeURIComponent(d.f)}`, d.f),
  });
}
