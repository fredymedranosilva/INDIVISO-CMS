// Utilidades de interfaz: plantillas con escape automático, formato de cifras, API, diálogos y avisos.

// ---------- Plantillas seguras: todo valor interpolado se escapa salvo raw() ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
const render = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v);
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
  return new Raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl); return el; };
export const $ = (s, c = document) => c.querySelector(s);
export const $$ = (s, c = document) => [...c.querySelectorAll(s)];

// ---------- Cifras ----------
const MXN = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
export const MINUS = '−';
export const pesos = (c, { signo = false } = {}) => {
  if (c == null) return '—';
  const s = '$' + MXN.format(Math.abs(c) / 100);
  return (c < 0 ? MINUS : signo && c > 0 ? '+' : '') + s;
};
export const pesosCortos = c => '$' + INT.format(Math.round(c / 100));
export const entero = n => INT.format(n);
export const pct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d).replace('.', '.') + '%';
// importe como celda: los ceros se ven como ceros, en gris
export const m = (c, cls = '') => html`<span class="num ${c === 0 ? 'zero' : ''} ${cls}">${pesos(c)}</span>`;
export function parsePesos(str) {
  const s = String(str ?? '').replace(/[$\s,]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [e, d = ''] = s.split('.');
  return Number(e) * 100 + Number((d + '00').slice(0, 2));
}
export const centsToInput = c => c == null ? '' : (c / 100).toFixed(2);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const mesNombre = p => `${MESES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
export const mesCorto = p => MES3[+p.slice(5, 7) - 1];
export const fecha = f => f ? `${+f.slice(8, 10)} ${MES3[+f.slice(5, 7) - 1]} ${f.slice(0, 4)}` : '—';
export const fechaHora = ts => ts ? new Date(ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const pad = n => String(n).padStart(2, '0');
export const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const periodoActual = () => hoy().slice(0, 7);
export const addMonths = (p, n) => { const [y, mm] = p.split('-').map(Number); const t = y * 12 + mm - 1 + n; return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}`; };
export const idem = () => crypto.randomUUID().replace(/-/g, '');

export const ESTADO_PAGO = { aplicado: ['Aplicado', 'pos'], por_validar: ['Por validar', 'warn'], rechazado: ['Rechazado', 'neg'], cancelado: ['Cancelado', 'neutral'] };
export const ESTADO_EGRESO = { por_aprobar: ['Por aprobar', 'warn'], aprobado: ['Por pagar', 'neutral'], pagado: ['Pagado', 'pos'], rechazado: ['Rechazado', 'neg'], cancelado: ['Cancelado', 'neutral'] };
export const pill = ([t, k]) => html`<span class="pill ${k}">${t}</span>`;
export const METODOS = { transferencia: 'Transferencia', deposito: 'Depósito', efectivo: 'Efectivo', tarjeta: 'Tarjeta', cheque: 'Cheque', domiciliacion: 'Domiciliación' };

// ---------- API ----------
export const S = { me: null, csrf: null, condos: [], cid: null, rol: null };
export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && S.csrf ? { 'x-csrf-token': S.csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.code !== undefined && path !== '/api/auth/login' && path !== '/api/auth/mfa') { window.dispatchEvent(new CustomEvent('sesion-expirada')); }
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status, code: j.code });
  return j;
}
export const capi = (path, opts) => api(`/api/c/${S.cid}${path}`, opts);
export async function descargar(path, nombre) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'No se pudo descargar.'); }
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const leerArchivo = file => new Promise((ok, ko) => {
  if (file.size > 5 * 1024 * 1024) return ko(new Error('El archivo excede 5 MB.'));
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(',')[1]);
  fr.onerror = () => ko(new Error('No se pudo leer el archivo.'));
  fr.readAsDataURL(file);
});

export const puede = perm => ({
  ver: ['admin', 'contador', 'comite'], capturar: ['admin', 'contador'], aprobar: ['admin', 'comite'],
  cancelar: ['admin'], cerrar: ['admin'], config: ['admin'], usuarios: ['admin'], auditoria: ['admin', 'comite'], comunicar: ['admin', 'comite'],
}[perm] || []).includes(S.rol);

// ---------- Avisos ----------
export function toast(msg, tipo = 'ok') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${tipo}`; t.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, tipo === 'error' ? 6000 : 3500);
}
export const errorToast = e => toast(e.message || String(e), 'error');

// ---------- Diálogos ----------
// dialogo({ titulo, cuerpo: html, acciones: [{ label, primary, value }], ancho, onSubmit(form, value) → true cierra })
export function dialogo({ titulo, cuerpo, acciones = [{ label: 'Cerrar', value: 'cancel' }], ancho = '', onSubmit, onOpen }) {
  const d = document.createElement('dialog');
  d.className = `dlg ${ancho}`;
  mount(d, html`<form method="dialog" class="dlg-form" novalidate>
    <header class="dlg-head"><h2>${titulo}</h2><button class="icon-btn" value="cancel" aria-label="Cerrar" formnovalidate>${raw(ICON.x)}</button></header>
    <div class="dlg-body">${cuerpo}</div>
    <p class="dlg-error" role="alert" hidden></p>
    <footer class="dlg-foot">${acciones.map(a => html`<button class="btn ${a.primary ? 'primary' : a.danger ? 'danger' : ''}" value="${a.value || 'ok'}" ${a.value === 'cancel' ? raw('formnovalidate') : ''}>${a.label}</button>`)}</footer>
  </form>`);
  document.body.appendChild(d);
  const form = d.querySelector('form');
  const err = d.querySelector('.dlg-error');
  form.addEventListener('submit', async ev => {
    const value = ev.submitter?.value || 'ok';
    if (value === 'cancel' || !onSubmit) return;
    ev.preventDefault();
    err.hidden = true;
    const btns = $$('.dlg-foot button', d); btns.forEach(b => { b.disabled = true; });
    try { if (await onSubmit(form, value) !== false) d.close(); }
    catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { btns.forEach(b => { b.disabled = false; }); }
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  onOpen?.(d, form);
  return d;
}
export const confirmar = (titulo, texto, { label = 'Confirmar', danger = false, motivo = false } = {}) => new Promise(ok => {
  let res = null;
  const d = dialogo({ titulo, cuerpo: html`<p class="lead">${texto}</p>${motivo ? html`<label class="field"><span>Motivo (queda en la bitácora)</span><textarea name="motivo" required maxlength="200" rows="2"></textarea></label>` : ''}`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label, primary: !danger, danger, value: 'ok' }],
    onSubmit: f => { const mo = f.motivo?.value.trim(); if (motivo && !mo) throw new Error('Indique el motivo.'); res = motivo ? mo : true; } });
  d.addEventListener('close', () => ok(res));
});

export const val = (form, name) => form.elements[name]?.value?.trim() ?? '';
export function pesosDe(form, name, { requerido = true, cero = false } = {}) {
  const s = val(form, name);
  if (!s && !requerido) return 0;
  const c = parsePesos(s);
  if (c == null || (!cero && c === 0)) throw new Error('Revise el importe: use números, por ejemplo 3,450.00');
  return c;
}

// ---------- Íconos (trazo de 1.5px, sin relleno) ----------
const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  x: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  tablero: I('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>'),
  cobranza: I('<path d="M3 7h18v10H3z"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'),
  morosidad: I('<path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  egresos: I('<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h3"/>'),
  bancos: I('<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
  unidades: I('<path d="M4 21V5l8-2v18M12 21V9l8 2v10M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2"/>'),
  estados: I('<path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21z"/><path d="M10 8h4M10 12h4"/>'),
  presupuesto: I('<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  contabilidad: I('<path d="M4 5h16M4 12h16M4 19h16M9 5v14"/>'),
  reportes: I('<path d="M5 20V10M10 20V4M15 20v-7M20 20v-11"/>'),
  cierres: I('<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  seguridad: I('<path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>'),
  config: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>'),
  consolidado: I('<path d="M3 21h18M5 21V9l4-3v15M10 21V4l5 3v14M15 21v-9l4 2v7"/>'),
  menu: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  comunidad: I('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  salir: I('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  imprimir: I('<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>'),
  descargar: I('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  subir: I('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  mas: I('<path d="M12 5v14M5 12h14"/>'),
  check: I('<path d="m5 12 4.5 4.5L19 7"/>'),
  luna: I('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  sol: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  buscar: I('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  candado: I('<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  abierto: I('<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/>'),
};

// Marca de Indiviso: una fracción de fachada (la parte proporcional de cada condómino).
export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true" class="logo"><rect x="3" y="3" width="26" height="26" rx="6" class="logo-bg"/><path d="M9 23V11l7-3 7 3v12" class="logo-line"/><path d="M16 8v15" class="logo-line"/><rect x="16" y="15" width="7" height="8" class="logo-part"/></svg>`;

// Tabla genérica: columnas [{ t: 'Título', k: fila => contenido, num: true, cls }]
export function tabla(cols, rows, { vacio = 'Sin registros.', fila = null, pie = null } = {}) {
  return html`<div class="table-wrap"><table class="tbl">
    <thead><tr>${cols.map(c => html`<th scope="col" class="${c.num ? 'r' : ''} ${c.cls || ''}">${c.t}</th>`)}</tr></thead>
    <tbody>${rows.length ? rows.map(r => html`<tr ${fila ? raw(fila(r)) : ''}>${cols.map(c => html`<td class="${c.num ? 'r num' : ''} ${c.cls || ''}">${c.k(r)}</td>`)}</tr>`)
      : html`<tr class="empty"><td colspan="${cols.length}">${vacio}</td></tr>`}</tbody>
    ${pie ? html`<tfoot><tr>${pie.map((p, i) => html`<td class="${cols[i]?.num ? 'r num' : ''}">${p}</td>`)}</tr></tfoot>` : ''}
  </table></div>`;
}

// Barra de progreso en SVG (sin estilos en línea)
export const barra = (v, { cls = '' } = {}) => {
  const p = Math.max(0, Math.min(1, v || 0)) * 100;
  return html`<svg class="meter ${cls}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="meter-track" width="100" height="6" rx="3"/><rect class="meter-fill" width="${p.toFixed(2)}" height="6" rx="3"/></svg>`;
};

export function tabs(items, activo, base) {
  return html`<nav class="tabs" aria-label="Secciones">${items.map(([k, l, n]) => html`<a href="${base}/${k}" class="tab" ${k === activo ? raw('aria-current="page"') : ''}>${l}${n ? html` <span class="count">${n}</span>` : ''}</a>`)}</nav>`;
}

export const cargando = el => mount(el, html`<div class="loading" aria-busy="true"><span></span><span></span><span></span></div>`);

// Impresión: un documento aislado en #print-root
export function imprimir(doc) {
  const root = $('#print-root');
  mount(root, doc);
  document.body.classList.add('printing');
  const fin = () => { document.body.classList.remove('printing'); root.innerHTML = ''; window.removeEventListener('afterprint', fin); };
  window.addEventListener('afterprint', fin);
  setTimeout(() => window.print(), 60);
}
