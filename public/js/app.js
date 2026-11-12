// Indiviso CMS · arranque, acceso, armazón y enrutador.
import { S, api, html, raw, mount, $, $$, ICON, LOGO, toast, errorToast, puede, capi, val } from './ui.js';

// ---------- Registro de módulos ----------
// Para agregar un panel nuevo: cree public/js/views/<id>.js con `export async function render(el, ctx)` y agregue
// una línea aquí. El menú, el enrutador, los permisos y el buscador lo toman de este registro.
//   id · título del menú · grupo · ícono (ICON) · permiso (ui.puede) · contador (opcional) · cargar
export const MODULOS = [
  { id: 'tablero', titulo: 'Tablero', grupo: null, icono: 'tablero', perm: 'ver', cargar: () => import('./views/tablero.js') },
  { id: 'cobranza', titulo: 'Cobranza', grupo: 'Ingresos', icono: 'cobranza', perm: 'ver', cargar: () => import('./views/cobranza.js') },
  { id: 'ingresos', titulo: 'Ingresos', grupo: 'Ingresos', icono: 'ingresos', perm: 'ver', cargar: () => import('./views/ingresos.js') },
  { id: 'morosidad', titulo: 'Morosidad', grupo: 'Ingresos', icono: 'morosidad', perm: 'ver', cargar: () => import('./views/morosidad.js') },
  { id: 'estados', titulo: 'Estados de cuenta', grupo: 'Ingresos', icono: 'estados', perm: 'ver', cargar: () => import('./views/estados.js') },
  { id: 'egresos', titulo: 'Egresos', grupo: 'Gasto y bancos', icono: 'egresos', perm: 'ver', contador: 'egresos', cargar: () => import('./views/egresos.js') },
  { id: 'bancos', titulo: 'Bancos y conciliación', grupo: 'Gasto y bancos', icono: 'bancos', perm: 'ver', contador: 'bancos', cargar: () => import('./views/bancos.js') },
  { id: 'unidades', titulo: 'Unidades y residentes', grupo: 'Padrón', icono: 'unidades', perm: 'ver', cargar: () => import('./views/unidades.js') },
  { id: 'presupuesto', titulo: 'Presupuesto', grupo: 'Finanzas', icono: 'presupuesto', perm: 'ver', cargar: () => import('./views/presupuesto.js') },
  { id: 'contabilidad', titulo: 'Contabilidad', grupo: 'Finanzas', icono: 'contabilidad', perm: 'ver', cargar: () => import('./views/contabilidad.js') },
  { id: 'reportes', titulo: 'Reportes', grupo: 'Finanzas', icono: 'reportes', perm: 'ver', cargar: () => import('./views/reportes.js') },
  { id: 'cierres', titulo: 'Cierres', grupo: 'Finanzas', icono: 'cierres', perm: 'ver', cargar: () => import('./views/cierres.js') },
  { id: 'seguridad', titulo: 'Seguridad', grupo: 'Administración', icono: 'seguridad', perm: 'ver', cargar: () => import('./views/seguridad.js') },
  { id: 'config', titulo: 'Configuración', grupo: 'Administración', icono: 'config', perm: 'ver', cargar: () => import('./views/config.js') },
  { id: 'mi', titulo: 'Mi estado de cuenta', grupo: null, icono: 'estados', perm: 'residente', residente: true, soloResidente: true, cargar: () => import('./views/residente.js') },
];
// Vistas globales (fuera de un condominio)
const GLOBALES = { consolidado: () => import('./views/consolidado.js'), admin: () => import('./views/admin.js') };
const VISTAS = Object.fromEntries(MODULOS.map(m => [m.id, m.cargar]));
const ROLES = { admin: 'Administración', contador: 'Contabilidad', comite: 'Comité de vigilancia', residente: 'Residente' };

let acciones = {};
let contadores = {};
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } } };

// ---------- Tema ----------
function aplicarTema(t) { document.documentElement.dataset.theme = t; store.set('idv-tema', t); }
aplicarTema(store.get('idv-tema') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- Acceso ----------
async function pantallaAcceso(mfa = false) {
  const root = $('#root');
  // Primera vez en un servidor nuevo: se crea el superadministrador desde aquí.
  let instalar = false;
  if (!mfa) { try { instalar = !!(await api('/api/instalacion')).pendiente; } catch { /* servidor sin instalador */ } }
  const celdas = Array.from({ length: 72 }, (_, i) => (i * 37) % 11 === 0 ? 'b' : (i * 13) % 5 === 0 ? 'p' : '');
  mount(root, html`<main class="auth">
    <section class="auth-art">
      <div class="brand">${raw(LOGO)}<div><b>Indiviso</b><small>CMS · gestión financiera condominal</small></div></div>
      <div><h1>Cada peso del condominio, en su lugar.</h1>
        <p>Cobranza, morosidad, egresos, conciliación bancaria, presupuesto y contabilidad de partida doble, con libro inmutable y bitácora a prueba de alteraciones.</p></div>
      <div class="auth-ledger" aria-hidden="true">${celdas.map(c => html`<i class="${c}"></i>`)}</div>
    </section>
    <section class="auth-form">
      ${mfa ? html`<form id="f-mfa" novalidate>
          <h2>Verificación en dos pasos</h2>
          <p class="lead">Escriba el código de 6 dígitos de su aplicación de autenticación, o uno de sus códigos de respaldo.</p>
          <label class="field"><span>Código</span><input name="code" autocomplete="one-time-code" maxlength="12" required autofocus></label>
          <p class="dlg-error" role="alert" hidden></p>
          <button class="btn primary">Verificar</button>
          <button class="link" type="button" data-salir>Usar otra cuenta</button>
        </form>`
      : instalar ? html`<form id="f-instalar" novalidate>
          <h2>Instalación</h2>
          <p class="lead">Cree la cuenta de superadministrador. Con ella dará de alta condominios y usuarios.</p>
          <label class="field"><span>Nombre</span><input name="nombre" autocomplete="name" required autofocus maxlength="120"></label>
          <label class="field"><span>Correo</span><input name="email" type="email" autocomplete="username" required></label>
          <label class="field"><span>Contraseña (12 caracteres o más)</span><input name="password" type="password" autocomplete="new-password" required minlength="12"></label>
          <label class="field"><span>Repita la contraseña</span><input name="password2" type="password" autocomplete="new-password" required></label>
          <p class="dlg-error" role="alert" hidden></p>
          <button class="btn primary">Crear y entrar</button>
          <p class="fine">Combine mayúsculas, minúsculas, números o símbolos. Después active la verificación en dos pasos en Seguridad.</p>
        </form>`
      : html`<form id="f-login" novalidate>
          <h2>Iniciar sesión</h2>
          <label class="field"><span>Correo</span><input name="email" type="email" autocomplete="username" required autofocus></label>
          <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
          <p class="dlg-error" role="alert" hidden></p>
          <button class="btn primary">Entrar</button>
          <p class="fine">Tras 5 intentos fallidos la cuenta se bloquea 15 minutos. Las sesiones expiran tras 30 minutos sin actividad.</p>
        </form>`}
    </section></main>`);
  const f = $('form', root), err = $('.dlg-error', root);
  f.addEventListener('submit', async ev => {
    ev.preventDefault(); err.hidden = true;
    const b = $('button.primary', f); b.disabled = true;
    try {
      if (mfa) { await api('/api/auth/mfa', { method: 'POST', body: { code: val(f, 'code') } }); }
      else if (instalar) {
        if (f.password.value !== f.password2.value) throw new Error('Las contraseñas no coinciden.');
        await api('/api/instalacion', { method: 'POST', body: { nombre: val(f, 'nombre'), email: val(f, 'email'), password: f.password.value } });
        await api('/api/auth/login', { method: 'POST', body: { email: val(f, 'email'), password: f.password.value } });
      }
      else {
        const r = await api('/api/auth/login', { method: 'POST', body: { email: val(f, 'email'), password: f.password.value } });
        if (r.mfa) { await cargarSesion(); return pantallaAcceso(true); }
        if (r.cambiar_password) { await cargarSesion(); return pantallaCambio(); }
      }
      await iniciar();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { b.disabled = false; }
  });
  $('[data-salir]', root)?.addEventListener('click', salir);
}

async function cargarSesion() {
  const me = await api('/api/auth/me');
  S.me = me.user; S.csrf = me.csrf; S.condos = me.condominios;
  return me;
}

async function salir() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* sesión ya cerrada */ }
  S.me = null; S.csrf = null; location.hash = '';
  pantallaAcceso();
}
window.addEventListener('sesion-expirada', () => { if (S.me) { S.me = null; toast('Su sesión expiró. Inicie sesión de nuevo.', 'error'); pantallaAcceso(); } });

// ---------- Armazón ----------
function shell() {
  const c = S.condos.find(x => x.id === S.cid);
  const ini = S.me.nombre.split(/\s+/).filter(w => /^\p{Lu}/u.test(w)).slice(0, 2).map(w => w[0]).join('') || S.me.nombre[0];
  const visibles = MODULOS.filter(m => S.rol === 'residente' ? m.residente : !m.soloResidente && puede(m.perm));
  const grupos = [...new Set(visibles.map(m => m.grupo))];
  const navItems = grupos.map(g => html`${g ? html`<p class="group-label">${g}</p>` : ''}${visibles.filter(m => m.grupo === g).map(m =>
    html`<a class="nav-item" href="#/c/${S.cid}/${m.id}" data-nav="${m.id}">${raw(ICON[m.icono])}<span>${m.titulo}</span>${m.contador ? html`<span class="count" data-count="${m.contador}" hidden></span>` : ''}</a>`)}`);
  const multi = S.condos.filter(x => x.rol !== 'residente').length > 1;
  mount($('#root'), html`<div class="app">
    <header class="topbar"><button class="icon-btn" data-menu aria-label="Abrir menú" aria-expanded="false">${raw(ICON.menu)}</button><b>${c?.nombre}</b></header>
    <aside class="sidebar" aria-label="Navegación">
      <div class="brand">${raw(LOGO)}<div><b>Indiviso</b><small>CMS financiero</small></div></div>
      <label class="switcher"><span class="sr">Condominio</span>
        <select data-switch>${S.condos.map(x => html`<option value="${x.id}" ${x.id === S.cid ? raw('selected') : ''}>${x.nombre}</option>`)}</select>
        <span class="rol">Rol: ${ROLES[S.rol]}${S.me.superadmin ? ' · superadministrador' : ''}</span></label>
      ${multi ? html`<a class="nav-item" href="#/consolidado" data-nav="consolidado">${raw(ICON.consolidado)}<span>Consolidado</span></a>` : ''}
      ${S.me.superadmin ? html`<a class="nav-item" href="#/admin" data-nav="admin">${raw(ICON.seguridad)}<span>Administración general</span></a>` : ''}
      <nav>${navItems}</nav>
      <div class="side-bottom">
        <button class="nav-item" data-tema>${raw(document.documentElement.dataset.theme === 'dark' ? ICON.sol : ICON.luna)}<span>${document.documentElement.dataset.theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}</span></button>
        <div class="user-row"><span class="avatar" data-tint="${S.me.id}">${ini}</span><span class="who"><b>${S.me.nombre}</b><span>${S.me.email}</span></span>
          <button class="icon-btn" data-salir aria-label="Cerrar sesión">${raw(ICON.salir)}</button></div>
      </div>
    </aside>
    <main class="canvas">${S.rol !== 'residente' ? html`<div class="topnav"><label class="gsearch"><span class="sr">Buscar</span>${raw(ICON.buscar)}<input type="search" data-gsearch placeholder="Buscar unidad, residente, recibo, egreso o proveedor" autocomplete="off"><kbd>Ctrl K</kbd><div class="gres" data-gres hidden></div></label><span class="fecha">${new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span></div>` : ''}<div id="view" tabindex="-1"></div></main>
  </div>`);
  tintar($('.avatar'));
  buscadorGlobal();
  $('[data-switch]').addEventListener('change', e => { const id = +e.target.value; const vista = location.hash.split('/')[3] || 'tablero'; cambiarCondo(id, vista); });
  $('[data-salir]').addEventListener('click', salir);
  $('[data-tema]').addEventListener('click', () => { aplicarTema(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); shell(); enrutar(); });
  $('[data-menu]').addEventListener('click', e => { const app = $('.app'); const open = app.classList.toggle('nav-open'); e.currentTarget.setAttribute('aria-expanded', open); });
  $('.sidebar').addEventListener('click', e => { if (e.target.closest('a.nav-item')) $('.app').classList.remove('nav-open'); });
}
export function tintar(el) { if (!el) return; const h = (+el.dataset.tint * 67) % 360; el.style.background = `hsl(${h} 32% 90%)`; el.style.color = `hsl(${h} 40% 24%)`; }

function cambiarCondo(id, vista = 'tablero') {
  const c = S.condos.find(x => x.id === id); if (!c) return;
  S.cid = id; S.rol = c.rol; store.set('idv-condo', String(id));
  const v = c.rol === 'residente' ? 'mi' : (VISTAS[vista] && vista !== 'mi' ? vista : 'tablero');
  shell();
  location.hash = `#/c/${id}/${v}`;
  enrutar();
}

export async function refrescarContadores() {
  if (!S.cid || S.rol === 'residente') return;
  try {
    const t = await capi(`/tablero`);
    contadores = { egresos: t.pendientes.egresos_por_aprobar, bancos: t.pendientes.movs_sin_conciliar };
    for (const el of $$('[data-count]')) { const n = contadores[el.dataset.count]; el.textContent = n; el.hidden = !n; el.setAttribute('aria-label', `${n} pendientes`); }
  } catch { /* contadores no críticos */ }
}

// ---------- Enrutador ----------
let ruta = 0;
async function enrutar() {
  if (!S.me) return;
  const partes = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  let vista, params;
  if (GLOBALES[partes[0]]) { vista = partes[0]; params = partes.slice(1); }
  else if (partes[0] === 'c' && /^\d+$/.test(partes[1])) {
    const id = +partes[1];
    if (id !== S.cid) { const c = S.condos.find(x => x.id === id); if (!c) { location.hash = `#/c/${S.cid}/tablero`; return; } S.cid = id; S.rol = c.rol; store.set('idv-condo', String(id)); shell(); }
    vista = partes[2] || 'tablero'; params = partes.slice(3);
  } else { location.hash = `#/c/${S.cid}/${S.rol === 'residente' ? 'mi' : 'tablero'}`; return; }
  if (!GLOBALES[vista]) {
    const mod = MODULOS.find(m => m.id === vista);
    if (S.rol === 'residente' && !mod?.residente) { location.hash = `#/c/${S.cid}/mi`; return; }
    if (!mod) vista = 'tablero';
  }
  for (const a of $$('[data-nav]')) { if (a.dataset.nav === vista) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const el = $('#view');
  const yo = ++ruta;
  try {
    const mod = await (GLOBALES[vista] || VISTAS[vista])();
    if (yo !== ruta) return;
    acciones = {};
    const ctx = { params, base: `#/c/${S.cid}/${vista}`, recargar: () => enrutar(), acciones: a => { Object.assign(acciones, a); } };
    await mod.render(el, ctx);
    if (yo !== ruta) return;
    document.title = `${$('h1', el)?.textContent || 'Indiviso'} · Indiviso CMS`;
  } catch (e) {
    if (yo !== ruta) return;
    mount(el, html`<div class="error-state" role="alert"><b>No se pudo cargar esta sección.</b> ${e.message}</div>`);
  }
  refrescarContadores();
}
window.addEventListener('hashchange', () => { enrutar(); $('#view')?.focus({ preventScroll: true }); window.scrollTo(0, 0); });

// Delegación de eventos: filas con data-href y botones con data-action.
document.addEventListener('click', async e => {
  const act = e.target.closest('[data-action]');
  if (act && acciones[act.dataset.action]) {
    e.preventDefault();
    try { await acciones[act.dataset.action](act.dataset, act); } catch (err) { errorToast(err); }
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button,input,select')) location.hash = row.dataset.href;
});
document.addEventListener('keydown', e => {
  const row = e.target.closest?.('tr[data-href]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.hash = row.dataset.href; }
});
document.addEventListener('change', async e => {
  const act = e.target.closest('[data-change]');
  if (act && acciones[act.dataset.change]) { try { await acciones[act.dataset.change](act.dataset, act); } catch (err) { errorToast(err); } }
});

// ---------- Inicio ----------
// Contraseña temporal: hay que cambiarla antes de entrar al sistema.
function pantallaCambio() {
  mount($('#root'), html`<main class="auth"><section class="auth-art"><div class="brand">${raw(LOGO)}<div><b>Indiviso</b><small>CMS · administración de condominios</small></div></div>
      <div><h1>Bienvenido.</h1><p>Por seguridad, reemplace la contraseña temporal por una propia antes de continuar.</p></div><div></div></section>
    <section class="auth-form"><form id="f-cambio" novalidate><h2>Elija su contraseña</h2>
      <label class="field"><span>Contraseña temporal</span><input name="actual" type="password" autocomplete="current-password" required autofocus></label>
      <label class="field"><span>Nueva contraseña</span><input name="nueva" type="password" autocomplete="new-password" minlength="12" required></label>
      <label class="field"><span>Confirmar nueva contraseña</span><input name="conf" type="password" autocomplete="new-password" required></label>
      <p class="fine">Mínimo 12 caracteres combinando al menos tres tipos: minúsculas, mayúsculas, números o símbolos.</p>
      <p class="dlg-error" role="alert" hidden></p><button class="btn primary">Guardar y entrar</button><button class="link" type="button" data-salir>Salir</button></form></section></main>`);
  const f = $('#f-cambio'), err = $('.dlg-error', f);
  f.addEventListener('submit', async ev => {
    ev.preventDefault(); err.hidden = true;
    try {
      if (f.nueva.value !== f.conf.value) throw new Error('Las contraseñas no coinciden.');
      await api('/api/auth/password', { method: 'POST', body: { actual: f.actual.value, nueva: f.nueva.value } });
      await iniciar();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $('[data-salir]', f).addEventListener('click', salir);
}

async function iniciar() {
  const me = await cargarSesion();
  if (me.mfa_pendiente) return pantallaAcceso(true);
  if (me.cambiar_password) return pantallaCambio();
  if (!S.condos.length && S.me.superadmin) { mount($('#root'), html`<div id="view"></div>`); location.hash = '#/admin'; return enrutarAdmin(); }
  if (!S.condos.length) {
    mount($('#root'), html`<main class="auth-form"><form><h2>Sin condominios asignados</h2><p class="lead">Su usuario no tiene acceso a ningún condominio. Solicite acceso al administrador.</p><button class="btn" type="button" data-salir>Cerrar sesión</button></form></main>`);
    return $('[data-salir]').addEventListener('click', salir);
  }
  const guardado = +store.get('idv-condo');
  const desdeHash = +(location.hash.match(/^#\/c\/(\d+)/)?.[1] || 0);
  const c = S.condos.find(x => x.id === desdeHash) || S.condos.find(x => x.id === guardado) || S.condos[0];
  S.cid = c.id; S.rol = c.rol;
  shell();
  if (!location.hash || location.hash === '#') location.hash = `#/c/${S.cid}/${S.rol === 'residente' ? 'mi' : 'tablero'}`;
  else enrutar();
}

iniciar().catch(() => pantallaAcceso());

// ---------- Buscador global (Ctrl K) ----------
function buscadorGlobal() {
  const inp = $('[data-gsearch]'), box = $('[data-gres]');
  if (!inp) return;
  let t = null, n = 0, sel = -1;
  const cerrar = () => { box.hidden = true; sel = -1; };
  const pintar = r => {
    const base = `#/c/${S.cid}`;
    const sec = (titulo, items, fn) => items.length ? html`<h4>${titulo}</h4>${items.map(fn)}` : '';
    const pesosT = c => '$' + (c / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = Object.values(r).reduce((a, x) => a + x.length, 0);
    mount(box, total ? html`
      ${sec('Unidades', r.unidades, u => html`<a href="${base}/unidades/${u.id}"><span><b>${u.clave}</b> ${u.personas || ''}</span><small>${u.referencia}</small></a>`)}
      ${sec('Residentes', r.personas, p => html`<a href="${base}/${p.unidad_id ? `unidades/${p.unidad_id}` : 'unidades'}"><span>${p.nombre}</span><small>${p.unidades || p.email || ''}</small></a>`)}
      ${sec('Recibos', r.pagos, p => html`<a href="${base}/estados/?u=${p.unidad_id}"><span>R-${p.folio || '—'} · ${p.clave}</span><small>${pesosT(p.monto_cents)} · ${p.fecha}</small></a>`)}
      ${sec('Egresos', r.egresos, e => html`<a href="${base}/egresos/egresos?anio=${e.fecha.slice(0, 4)}&mes=${+e.fecha.slice(5, 7)}"><span>E-${e.folio} · ${e.concepto}</span><small>${pesosT(e.total_cents)}</small></a>`)}
      ${sec('Proveedores', r.proveedores, p => html`<a href="${base}/egresos/proveedores"><span>${p.nombre}</span><small>${p.rfc || p.giro || ''}</small></a>`)}`
      : html`<p class="vacio">Sin resultados.</p>`);
    box.hidden = false;
  };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim();
    if (q.length < 2) return cerrar();
    t = setTimeout(async () => { const yo = ++n; try { const r = await capi(`/buscar?q=${encodeURIComponent(q)}`); if (yo === n) pintar(r); } catch { cerrar(); } }, 180);
  });
  inp.addEventListener('keydown', e => {
    const ls = [...box.querySelectorAll('a')];
    if (e.key === 'Escape') { cerrar(); inp.blur(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && ls.length) { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + ls.length) % ls.length; ls.forEach((a, i) => a.classList.toggle('on', i === sel)); }
    else if (e.key === 'Enter' && ls.length) { e.preventDefault(); location.hash = (ls[sel] || ls[0]).getAttribute('href'); cerrar(); inp.value = ''; }
  });
  box.addEventListener('click', e => { if (e.target.closest('a')) { cerrar(); inp.value = ''; } });
  inp.addEventListener('blur', () => setTimeout(cerrar, 150));
}
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const i = $('[data-gsearch]'); if (i) { e.preventDefault(); i.focus(); i.select(); } } });

// Superadministrador sin condominios aún (instalación nueva): solo la administración general.
async function enrutarAdmin() {
  const el = $('#view'); el.className = 'canvas solo';
  const mod = await GLOBALES.admin();
  const ctx = { params: [], base: '#/admin', recargar: () => iniciar(), acciones: a => { Object.assign(acciones, a); } };
  acciones = {};
  await mod.render(el, ctx);
}
