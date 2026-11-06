// Indiviso CMS · arranque, acceso, armazón y enrutador.
import { S, api, html, raw, mount, $, $$, ICON, LOGO, toast, errorToast, puede, capi, val } from './ui.js';

const VISTAS = {
  tablero: () => import('./views/tablero.js'),
  cobranza: () => import('./views/cobranza.js'),
  morosidad: () => import('./views/morosidad.js'),
  egresos: () => import('./views/egresos.js'),
  bancos: () => import('./views/bancos.js'),
  unidades: () => import('./views/unidades.js'),
  estados: () => import('./views/estados.js'),
  presupuesto: () => import('./views/presupuesto.js'),
  contabilidad: () => import('./views/contabilidad.js'),
  reportes: () => import('./views/reportes.js'),
  cierres: () => import('./views/cierres.js'),
  seguridad: () => import('./views/seguridad.js'),
  config: () => import('./views/config.js'),
  mi: () => import('./views/residente.js'),
  consolidado: () => import('./views/consolidado.js'),
};

const NAV = [
  [null, [['tablero', 'Tablero', 'tablero', 'ver']]],
  ['Cobranza', [['cobranza', 'Cobranza', 'cobranza', 'ver', 'pagos'], ['morosidad', 'Morosidad', 'morosidad', 'ver'], ['estados', 'Estados de cuenta', 'estados', 'ver']]],
  ['Gasto y bancos', [['egresos', 'Egresos', 'egresos', 'ver', 'egresos'], ['bancos', 'Bancos y conciliación', 'bancos', 'ver', 'bancos']]],
  ['Padrón', [['unidades', 'Unidades y residentes', 'unidades', 'ver']]],
  ['Finanzas', [['presupuesto', 'Presupuesto', 'presupuesto', 'ver'], ['contabilidad', 'Contabilidad', 'contabilidad', 'ver'], ['reportes', 'Reportes', 'reportes', 'ver'], ['cierres', 'Cierres', 'cierres', 'ver']]],
  ['Administración', [['seguridad', 'Seguridad', 'seguridad', 'ver'], ['config', 'Configuración', 'config', 'ver']]],
];
const ROLES = { admin: 'Administración', contador: 'Contabilidad', comite: 'Comité de vigilancia', residente: 'Residente' };

let acciones = {};
let contadores = {};
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } } };

// ---------- Tema ----------
function aplicarTema(t) { document.documentElement.dataset.theme = t; store.set('idv-tema', t); }
aplicarTema(store.get('idv-tema') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- Acceso ----------
function pantallaAcceso(mfa = false) {
  const root = $('#root');
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
          <p class="lead">Escriba el código de 6 dígitos de su aplicación de autenticación.</p>
          <label class="field"><span>Código</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
          <p class="dlg-error" role="alert" hidden></p>
          <button class="btn primary">Verificar</button>
          <button class="link" type="button" data-salir>Usar otra cuenta</button>
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
      else {
        const r = await api('/api/auth/login', { method: 'POST', body: { email: val(f, 'email'), password: f.password.value } });
        if (r.mfa) { await cargarSesion(); return pantallaAcceso(true); }
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
  const navItems = S.rol === 'residente'
    ? html`<a class="nav-item" href="#/c/${S.cid}/mi" data-nav="mi">${raw(ICON.estados)}Mi estado de cuenta</a>`
    : NAV.map(([g, items]) => html`${g ? html`<p class="group-label">${g}</p>` : ''}${items.filter(i => puede(i[3])).map(([k, l, ic, , cnt]) =>
        html`<a class="nav-item" href="#/c/${S.cid}/${k}" data-nav="${k}">${raw(ICON[ic])}<span>${l}</span>${cnt ? html`<span class="count" data-count="${cnt}" hidden></span>` : ''}</a>`)}`);
  const multi = S.condos.filter(x => x.rol !== 'residente').length > 1;
  mount($('#root'), html`<div class="app">
    <header class="topbar"><button class="icon-btn" data-menu aria-label="Abrir menú" aria-expanded="false">${raw(ICON.menu)}</button><b>${c?.nombre}</b></header>
    <aside class="sidebar" aria-label="Navegación">
      <div class="brand">${raw(LOGO)}<div><b>Indiviso</b><small>CMS financiero</small></div></div>
      <label class="switcher"><span class="sr">Condominio</span>
        <select data-switch>${S.condos.map(x => html`<option value="${x.id}" ${x.id === S.cid ? raw('selected') : ''}>${x.nombre}</option>`)}</select>
        <span class="rol">Rol: ${ROLES[S.rol]}${S.me.superadmin ? ' · superadministrador' : ''}</span></label>
      ${multi ? html`<a class="nav-item" href="#/consolidado" data-nav="consolidado">${raw(ICON.consolidado)}<span>Consolidado</span></a>` : ''}
      <nav>${navItems}</nav>
      <div class="side-bottom">
        <button class="nav-item" data-tema>${raw(document.documentElement.dataset.theme === 'dark' ? ICON.sol : ICON.luna)}<span>${document.documentElement.dataset.theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}</span></button>
        <div class="user-row"><span class="avatar" data-tint="${S.me.id}">${ini}</span><span class="who"><b>${S.me.nombre}</b><span>${S.me.email}</span></span>
          <button class="icon-btn" data-salir aria-label="Cerrar sesión">${raw(ICON.salir)}</button></div>
      </div>
    </aside>
    <main class="canvas" id="view" tabindex="-1"></main>
  </div>`);
  tintar($('.avatar'));
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
    contadores = { pagos: t.pendientes.pagos_por_validar, egresos: t.pendientes.egresos_por_aprobar, bancos: t.pendientes.movs_sin_conciliar };
    for (const el of $$('[data-count]')) { const n = contadores[el.dataset.count]; el.textContent = n; el.hidden = !n; el.setAttribute('aria-label', `${n} pendientes`); }
  } catch { /* contadores no críticos */ }
}

// ---------- Enrutador ----------
let ruta = 0;
async function enrutar() {
  if (!S.me) return;
  const partes = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  let vista, params;
  if (partes[0] === 'consolidado') { vista = 'consolidado'; params = []; }
  else if (partes[0] === 'c' && /^\d+$/.test(partes[1])) {
    const id = +partes[1];
    if (id !== S.cid) { const c = S.condos.find(x => x.id === id); if (!c) { location.hash = `#/c/${S.cid}/tablero`; return; } S.cid = id; S.rol = c.rol; store.set('idv-condo', String(id)); shell(); }
    vista = partes[2] || 'tablero'; params = partes.slice(3);
  } else { location.hash = `#/c/${S.cid}/${S.rol === 'residente' ? 'mi' : 'tablero'}`; return; }
  if (S.rol === 'residente' && vista !== 'mi') { location.hash = `#/c/${S.cid}/mi`; return; }
  if (!VISTAS[vista]) { vista = 'tablero'; }
  for (const a of $$('[data-nav]')) { if (a.dataset.nav === vista) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const el = $('#view');
  const yo = ++ruta;
  try {
    const mod = await VISTAS[vista]();
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
async function iniciar() {
  const me = await cargarSesion();
  if (me.mfa_pendiente) return pantallaAcceso(true);
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
