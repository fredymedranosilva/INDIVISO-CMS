// Autenticación: sesiones de servidor, bloqueo por intentos, 2FA TOTP y CSRF.
import { timingSafeEqual } from 'node:crypto';
import { sha256, token, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, newTotpSecret, verifyTotp, rateLimit, audit } from './security.mjs';
import { fail, v } from './util.mjs';
import { tx } from './db.mjs';

const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 12 * 60 * 60 * 1000;
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
export const COOKIE = 'idv_s';

export function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(ctx, value, maxAge) {
  const secure = ctx.secure ? '; Secure' : '';
  const name = ctx.secure ? `__Host-${COOKIE}` : COOKIE;
  ctx.res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

// Carga la sesión de la cookie y aplica expiración por inactividad y absoluta.
export function loadSession(ctx) {
  const c = parseCookies(ctx.req.headers.cookie);
  const raw = c[`__Host-${COOKIE}`] || c[COOKIE];
  if (!raw || raw.length > 100) return;
  const s = ctx.db.prepare('SELECT * FROM sesiones WHERE id = ?').get(sha256(raw));
  const now = Date.now();
  if (!s || s.revocada || s.expires_at < now || now - s.last_seen > IDLE_MS) return;
  const u = ctx.db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(s.usuario_id);
  if (!u) return;
  if (now - s.last_seen > 30000) ctx.db.prepare('UPDATE sesiones SET last_seen = ? WHERE id = ?').run(now, s.id);
  ctx.sess = s; ctx.user = u;
}

export function checkCsrf(ctx) {
  const got = String(ctx.req.headers['x-csrf-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(ctx.sess.csrf);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail(403, 'Token de seguridad inválido. Recargue la página.', 'CSRF');
}

export function checkOrigin(ctx) {
  const origin = ctx.req.headers.origin;
  if (!origin) return;
  try { if (new URL(origin).host !== ctx.req.headers.host) fail(403, 'Origen no permitido.', 'ORIGEN'); }
  catch (e) { if (e.status) throw e; fail(403, 'Origen no permitido.', 'ORIGEN'); }
}

function crearSesion(ctx, u, mfaOk) {
  const raw = token(32);
  const now = Date.now();
  ctx.db.prepare('INSERT INTO sesiones (id, usuario_id, csrf, ip, ua, mfa_ok, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha256(raw), u.id, token(24), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200), mfaOk ? 1 : 0, now, now, now + ABS_MS);
  setCookie(ctx, raw, ABS_MS / 1000);
}

export function membresias(db, u) {
  if (u.superadmin) return db.prepare("SELECT id, nombre, ciudad, 'admin' AS rol FROM condominios WHERE activo = 1 ORDER BY nombre").all();
  return db.prepare('SELECT c.id, c.nombre, c.ciudad, m.rol FROM membresias m JOIN condominios c ON c.id = m.condominio_id WHERE m.usuario_id = ? AND c.activo = 1 ORDER BY c.nombre').all(u.id);
}

export const authRoutes = [
  ['POST', '/api/auth/login', { publico: true }, ctx => {
    if (!rateLimit('login:' + ctx.ip, 20, 15 * 60 * 1000)) fail(429, 'Demasiados intentos. Espere 15 minutos.');
    const b = v(ctx.body, { email: 'email', password: 'str|max128' });
    const u = ctx.db.prepare('SELECT * FROM usuarios WHERE email = ?').get(b.email);
    const now = Date.now();
    const ok = verifyPassword(b.password, u?.pass_hash || DUMMY_HASH); // mismo costo exista o no el usuario
    if (!u || !u.activo || (u.bloqueado_hasta && u.bloqueado_hasta > now) || !ok) {
      tx(ctx.db, () => {
        if (u && ok === false && !(u.bloqueado_hasta > now)) {
          const n = u.intentos_fallidos + 1;
          ctx.db.prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?').run(n >= MAX_INTENTOS ? 0 : n, n >= MAX_INTENTOS ? now + BLOQUEO_MS : null, u.id);
          if (n >= MAX_INTENTOS) audit(ctx.db, { usuario_id: u.id, ip: ctx.ip, accion: 'cuenta_bloqueada' });
        }
        audit(ctx.db, { usuario_id: u?.id ?? null, ip: ctx.ip, accion: 'login_fallido', detalle: { email: b.email } });
      });
      if (u && u.bloqueado_hasta > now) fail(423, 'Cuenta bloqueada temporalmente por intentos fallidos.');
      fail(401, 'Correo o contraseña incorrectos.');
    }
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?').run(now, u.id);
      crearSesion(ctx, u, !u.totp_activo);
      audit(ctx.db, { usuario_id: u.id, ip: ctx.ip, accion: 'login' });
    });
    return { mfa: !!u.totp_activo };
  }],

  ['POST', '/api/auth/mfa', { mfaPendiente: true }, ctx => {
    if (!rateLimit('mfa:' + ctx.sess.id, 6, 5 * 60 * 1000)) fail(429, 'Demasiados intentos.');
    const { code } = v(ctx.body, { code: 'str|max6' });
    const step = verifyTotp(ctx.user.totp_secret, code, ctx.user.totp_ultimo_paso);
    if (!step) { audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_fallido' }); fail(401, 'Código incorrecto.'); }
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET totp_ultimo_paso = ? WHERE id = ?').run(step, ctx.user.id);
      ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?').run(ctx.sess.id);
      crearSesion(ctx, ctx.user, true); // rotación de sesión tras elevar privilegios
    });
    return { ok: true };
  }],

  ['POST', '/api/auth/logout', { mfaPendiente: true }, ctx => {
    ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?').run(ctx.sess.id);
    setCookie(ctx, '', 0);
    return { ok: true };
  }],

  ['GET', '/api/auth/me', { mfaPendiente: true }, ctx => ({
    mfa_pendiente: !ctx.sess.mfa_ok,
    csrf: ctx.sess.csrf,
    user: { id: ctx.user.id, nombre: ctx.user.nombre, email: ctx.user.email, superadmin: !!ctx.user.superadmin, totp: !!ctx.user.totp_activo },
    condominios: ctx.sess.mfa_ok ? membresias(ctx.db, ctx.user) : [],
  })],

  ['POST', '/api/auth/password', {}, ctx => {
    const b = v(ctx.body, { actual: 'str|max128', nueva: 'str|max128' });
    if (!verifyPassword(b.actual, ctx.user.pass_hash)) fail(401, 'La contraseña actual no es correcta.');
    const p = passwordProblem(b.nueva, ctx.user.email); if (p) fail(400, p);
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET pass_hash = ?, pass_cambiado_at = ? WHERE id = ?').run(hashPassword(b.nueva), Date.now(), ctx.user.id);
      ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND id <> ?').run(ctx.user.id, ctx.sess.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'cambio_password' });
    });
    return { ok: true };
  }],

  ['POST', '/api/auth/totp/iniciar', {}, ctx => {
    if (ctx.user.totp_activo) fail(409, 'La verificación en dos pasos ya está activa.');
    const secret = newTotpSecret();
    ctx.db.prepare('UPDATE usuarios SET totp_secret = ? WHERE id = ?').run(secret, ctx.user.id);
    return { secret, uri: `otpauth://totp/Indiviso%20CMS:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=Indiviso%20CMS&digits=6&period=30` };
  }],
  ['POST', '/api/auth/totp/activar', {}, ctx => {
    const { code } = v(ctx.body, { code: 'str|max6' });
    if (!ctx.user.totp_secret) fail(400, 'Inicie primero la configuración.');
    const step = verifyTotp(ctx.user.totp_secret, code, 0);
    if (!step) fail(400, 'Código incorrecto. Verifique la hora de su teléfono.');
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET totp_activo = 1, totp_ultimo_paso = ? WHERE id = ?').run(step, ctx.user.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_activado' });
    });
    return { ok: true };
  }],
  ['POST', '/api/auth/totp/desactivar', {}, ctx => {
    const b = v(ctx.body, { password: 'str|max128', code: 'str|max6' });
    if (!verifyPassword(b.password, ctx.user.pass_hash) || !verifyTotp(ctx.user.totp_secret, b.code, ctx.user.totp_ultimo_paso)) fail(401, 'Contraseña o código incorrectos.');
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET totp_activo = 0, totp_secret = NULL WHERE id = ?').run(ctx.user.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_desactivado' });
    });
    return { ok: true };
  }],

  ['GET', '/api/auth/sesiones', {}, ctx => ctx.db.prepare('SELECT substr(id, 1, 12) AS id, ip, ua, created_at, last_seen FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ? ORDER BY last_seen DESC')
    .all(ctx.user.id, Date.now()).map(s => ({ ...s, actual: ctx.sess.id.startsWith(s.id) }))],
  ['POST', '/api/auth/sesiones/:sid/revocar', {}, ctx => {
    if (!/^[0-9a-f]{12}$/.test(ctx.params.sid)) fail(400, 'Sesión inválida.');
    ctx.db.prepare("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND substr(id, 1, 12) = ?").run(ctx.user.id, ctx.params.sid);
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'sesion_revocada' });
    return { ok: true };
  }],
];
