// Autenticación: sesiones de servidor, bloqueo por intentos, 2FA TOTP con códigos de respaldo y CSRF.
import { timingSafeEqual } from 'node:crypto';
import { sha256, token, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, newTotpSecret, verifyTotp, rateLimit, limiteExcedido, limiteLimpiar,
  nuevosCodigosRespaldo, normalizarCodigo, audit } from './security.mjs';
import { sellar, abrir } from './secretos.mjs';
import { fail, v } from './util.mjs';
import { tx } from './db.mjs';

const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 12 * 60 * 60 * 1000;
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const MAX_FALLOS_IP = 30;                     // intentos fallidos por conexión en 15 minutos
const MAX_SESIONES = 8;                       // sesiones simultáneas por usuario; al superarlas se cierra la más antigua
export const TEMPORAL_MS = 7 * 24 * 3600 * 1000; // vigencia de una contraseña temporal
export const COOKIE = 'idv_s';
const MSG_BLOQUEO = 'Demasiados intentos fallidos. Espere 15 minutos e intente de nuevo.';

export function parseCookies(h = '') {
  const out = {};
  for (const part of String(h).split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie mal formada: se ignora */ }
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
  const raw = ctx.secure ? c[`__Host-${COOKIE}`] : c[COOKIE];
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
  // Detrás del proxy del hospedaje el Host puede llegar reescrito: se acepta también X-Forwarded-Host.
  const hosts = [ctx.req.headers.host, process.env.INDIVISO_TRUST_PROXY === '1' ? String(ctx.req.headers['x-forwarded-host'] || '').split(',')[0].trim() : ''].filter(Boolean);
  try { if (!hosts.includes(new URL(origin).host)) fail(403, 'Origen no permitido.', 'ORIGEN'); }
  catch (e) { if (e.status) throw e; fail(403, 'Origen no permitido.', 'ORIGEN'); }
}

function crearSesion(ctx, u, mfaOk) {
  const raw = token(32);
  const now = Date.now();
  ctx.db.prepare('INSERT INTO sesiones (id, usuario_id, csrf, ip, ua, mfa_ok, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha256(raw), u.id, token(24), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200), mfaOk ? 1 : 0, now, now, now + ABS_MS);
  // Tope de sesiones simultáneas: se conservan las más recientes.
  const activas = ctx.db.prepare('SELECT id FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ? ORDER BY last_seen DESC').all(u.id, now);
  for (const s of activas.slice(MAX_SESIONES)) ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?').run(s.id);
  setCookie(ctx, raw, ABS_MS / 1000);
}

export const revocarSesionesDe = (db, uid, excepto = null) => db.prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0 AND id <> ?').run(uid, excepto || '').changes;

// Las sesiones vencidas o cerradas se eliminan (su rastro queda en la bitácora).
export function limpiarSesiones(db) {
  const limite = Date.now() - 24 * 3600 * 1000;
  return db.prepare('DELETE FROM sesiones WHERE expires_at < ? OR (revocada = 1 AND last_seen < ?)').run(limite, limite).changes;
}

export function membresias(db, u) {
  if (u.superadmin) return db.prepare("SELECT id, nombre, ciudad, 'admin' AS rol FROM condominios WHERE activo = 1 ORDER BY nombre").all();
  return db.prepare('SELECT c.id, c.nombre, c.ciudad, m.rol FROM membresias m JOIN condominios c ON c.id = m.condominio_id WHERE m.usuario_id = ? AND c.activo = 1 ORDER BY c.nombre').all(u.id);
}

// Verifica el segundo factor: código de 6 dígitos de la aplicación o un código de respaldo (un solo uso).
function verificarSegundoFactor(ctx, code, { permitirRespaldo = true } = {}) {
  const u = ctx.user, s = String(code || '').trim();
  if (/^\d{6}$/.test(s)) {
    let secreto = null;
    try { secreto = abrir(u.totp_secret); } catch { console.error('[2fa] no se pudo descifrar el secreto del usuario', u.id, '(¿falta secreto.key?)'); }
    const step = secreto ? verifyTotp(secreto, s, u.totp_ultimo_paso) : null;
    return step ? { step } : null;
  }
  if (!permitirRespaldo) return null;
  const n = normalizarCodigo(s);
  if (n.length !== 8) return null;
  const r = ctx.db.prepare('SELECT id FROM totp_respaldo WHERE usuario_id = ? AND hash = ? AND usado_at IS NULL').get(u.id, sha256(n));
  return r ? { respaldo: r.id } : null;
}
function consumirSegundoFactor(ctx, f) {
  if (f.step) ctx.db.prepare('UPDATE usuarios SET totp_ultimo_paso = ? WHERE id = ?').run(f.step, ctx.user.id);
  if (f.respaldo) {
    ctx.db.prepare('UPDATE totp_respaldo SET usado_at = ? WHERE id = ?').run(Date.now(), f.respaldo);
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_codigo_respaldo_usado' });
  }
}
function generarCodigos(ctx) {
  const codigos = nuevosCodigosRespaldo();
  ctx.db.prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?').run(ctx.user.id);
  const ins = ctx.db.prepare('INSERT INTO totp_respaldo (usuario_id, hash, created_at) VALUES (?,?,?)');
  for (const c of codigos) ins.run(ctx.user.id, sha256(normalizarCodigo(c)), Date.now());
  return codigos;
}
// Los fallos al comprobar contraseña o código dentro de una sesión también se limitan (sesión robada).
function exigirIntento(ctx, clave) { if (limiteExcedido(`${clave}:${ctx.user.id}`, MAX_INTENTOS)) fail(429, MSG_BLOQUEO); }
function fallo(ctx, clave, accion, msg, status = 401) {
  rateLimit(`${clave}:${ctx.user.id}`, MAX_INTENTOS, BLOQUEO_MS);
  audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion });
  fail(status, msg);
}

export const authRoutes = [
  ['POST', '/api/auth/login', { publico: true }, ctx => {
    // Por conexión solo cuentan los intentos fallidos: una oficina con muchos usuarios no se bloquea por entrar.
    const kIp = 'login:' + ctx.ip;
    if (limiteExcedido(kIp, MAX_FALLOS_IP)) fail(429, 'Demasiados intentos fallidos desde esta conexión. Espere 15 minutos.');
    const b = v(ctx.body, { email: 'email', password: 'str|max128' });
    // Límite por cuenta, exista o no: la respuesta no revela si el correo está registrado.
    const kEmail = 'login-email:' + sha256(b.email);
    if (limiteExcedido(kEmail, MAX_INTENTOS)) fail(429, MSG_BLOQUEO);
    const u = ctx.db.prepare('SELECT * FROM usuarios WHERE email = ?').get(b.email);
    const now = Date.now();
    const ok = verifyPassword(b.password, u?.pass_hash || DUMMY_HASH); // mismo costo exista o no el usuario
    const bloqueada = !!u && u.bloqueado_hasta > now;
    if (!u || !u.activo || bloqueada || !ok) {
      rateLimit(kEmail, MAX_INTENTOS, BLOQUEO_MS);
      rateLimit(kIp, MAX_FALLOS_IP, BLOQUEO_MS);
      tx(ctx.db, () => {
        if (u && !ok && !bloqueada) {
          const n = u.intentos_fallidos + 1;
          ctx.db.prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?').run(n >= MAX_INTENTOS ? 0 : n, n >= MAX_INTENTOS ? now + BLOQUEO_MS : null, u.id);
          if (n >= MAX_INTENTOS) audit(ctx.db, { usuario_id: u.id, ip: ctx.ip, accion: 'cuenta_bloqueada' });
        }
        audit(ctx.db, { usuario_id: u?.id ?? null, ip: ctx.ip, accion: 'login_fallido', detalle: { email: b.email } });
      });
      if (bloqueada || limiteExcedido(kEmail, MAX_INTENTOS)) fail(429, MSG_BLOQUEO);
      fail(401, 'Correo o contraseña incorrectos.');
    }
    if (u.debe_cambiar_pass && u.pass_temporal_hasta && u.pass_temporal_hasta < now) {
      audit(ctx.db, { usuario_id: u.id, ip: ctx.ip, accion: 'login_temporal_vencida' });
      fail(401, 'Su contraseña temporal venció. Pida a la administración que la restablezca.');
    }
    limiteLimpiar(kEmail);
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?').run(now, u.id);
      crearSesion(ctx, u, !u.totp_activo);
      audit(ctx.db, { usuario_id: u.id, ip: ctx.ip, accion: 'login' });
    });
    return { mfa: !!u.totp_activo, cambiar_password: !!u.debe_cambiar_pass };
  }],

  ['POST', '/api/auth/mfa', { mfaPendiente: true }, ctx => {
    if (!rateLimit('mfa:' + ctx.sess.id, 6, 5 * 60 * 1000)) fail(429, 'Demasiados intentos.');
    exigirIntento(ctx, 'mfa-u');
    const { code } = v(ctx.body, { code: 'str|max12' });
    if (!ctx.user.totp_activo) fail(400, 'La verificación en dos pasos no está activa.');
    const f = verificarSegundoFactor(ctx, code);
    if (!f) fallo(ctx, 'mfa-u', 'mfa_fallido', 'Código incorrecto.');
    limiteLimpiar(`mfa-u:${ctx.user.id}`);
    tx(ctx.db, () => {
      consumirSegundoFactor(ctx, f);
      ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?').run(ctx.sess.id);
      crearSesion(ctx, ctx.user, true); // rotación de sesión tras elevar privilegios
    });
    return { ok: true, respaldo: !!f.respaldo };
  }],

  ['POST', '/api/auth/logout', { mfaPendiente: true, cambioPendiente: true }, ctx => {
    ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?').run(ctx.sess.id);
    setCookie(ctx, '', 0);
    return { ok: true };
  }],

  ['GET', '/api/auth/me', { mfaPendiente: true, cambioPendiente: true }, ctx => ({
    mfa_pendiente: !ctx.sess.mfa_ok,
    cambiar_password: !!ctx.user.debe_cambiar_pass,
    csrf: ctx.sess.csrf,
    user: { id: ctx.user.id, nombre: ctx.user.nombre, email: ctx.user.email, superadmin: !!ctx.user.superadmin, totp: !!ctx.user.totp_activo,
      codigos_respaldo: ctx.sess.mfa_ok && ctx.user.totp_activo ? ctx.db.prepare('SELECT COUNT(*) n FROM totp_respaldo WHERE usuario_id = ? AND usado_at IS NULL').get(ctx.user.id).n : null },
    condominios: ctx.sess.mfa_ok && !ctx.user.debe_cambiar_pass ? membresias(ctx.db, ctx.user) : [],
  })],

  ['POST', '/api/auth/password', { cambioPendiente: true }, ctx => {
    exigirIntento(ctx, 'pass');
    const b = v(ctx.body, { actual: 'str|max128', nueva: 'str|max128' });
    if (!verifyPassword(b.actual, ctx.user.pass_hash)) fallo(ctx, 'pass', 'cambio_password_fallido', 'La contraseña actual no es correcta.');
    const p = passwordProblem(b.nueva, ctx.user.email); if (p) fail(400, p);
    if (b.nueva === b.actual) fail(400, 'La contraseña nueva debe ser distinta de la actual.');
    limiteLimpiar(`pass:${ctx.user.id}`);
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET pass_hash = ?, pass_cambiado_at = ?, debe_cambiar_pass = 0, pass_temporal_hasta = NULL WHERE id = ?').run(hashPassword(b.nueva), Date.now(), ctx.user.id);
      revocarSesionesDe(ctx.db, ctx.user.id, ctx.sess.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'cambio_password' });
    });
    return { ok: true };
  }],

  ['POST', '/api/auth/totp/iniciar', {}, ctx => {
    if (ctx.user.totp_activo) fail(409, 'La verificación en dos pasos ya está activa.');
    const secret = newTotpSecret();
    ctx.db.prepare('UPDATE usuarios SET totp_secret = ? WHERE id = ?').run(sellar(secret), ctx.user.id);
    return { secret, uri: `otpauth://totp/Indiviso%20CMS:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=Indiviso%20CMS&digits=6&period=30` };
  }],
  ['POST', '/api/auth/totp/activar', {}, ctx => {
    exigirIntento(ctx, 'totp');
    const { code } = v(ctx.body, { code: 'str|max6' });
    if (ctx.user.totp_activo) fail(409, 'La verificación en dos pasos ya está activa.');
    if (!ctx.user.totp_secret) fail(400, 'Inicie primero la configuración.');
    const step = verifyTotp(abrir(ctx.user.totp_secret), code, 0);
    if (!step) fallo(ctx, 'totp', 'mfa_activacion_fallida', 'Código incorrecto. Verifique la hora de su teléfono.', 400);
    return tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET totp_activo = 1, totp_ultimo_paso = ? WHERE id = ?').run(step, ctx.user.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_activado' });
      return { ok: true, codigos: generarCodigos(ctx) }; // se muestran una sola vez
    });
  }],
  ['POST', '/api/auth/totp/desactivar', {}, ctx => {
    exigirIntento(ctx, 'totp');
    const b = v(ctx.body, { password: 'str|max128', code: 'str|max12' });
    if (!ctx.user.totp_activo) fail(409, 'La verificación en dos pasos no está activa.');
    const f = verifyPassword(b.password, ctx.user.pass_hash) ? verificarSegundoFactor(ctx, b.code) : null;
    if (!f) fallo(ctx, 'totp', 'mfa_desactivacion_fallida', 'Contraseña o código incorrectos.');
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE usuarios SET totp_activo = 0, totp_secret = NULL, totp_ultimo_paso = NULL WHERE id = ?').run(ctx.user.id);
      ctx.db.prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?').run(ctx.user.id);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_desactivado' });
    });
    return { ok: true };
  }],
  // Genera códigos de respaldo nuevos (los anteriores dejan de servir).
  ['POST', '/api/auth/totp/codigos', {}, ctx => {
    exigirIntento(ctx, 'totp');
    const b = v(ctx.body, { password: 'str|max128', code: 'str|max6' });
    if (!ctx.user.totp_activo) fail(409, 'Active primero la verificación en dos pasos.');
    const f = verifyPassword(b.password, ctx.user.pass_hash) ? verificarSegundoFactor(ctx, b.code, { permitirRespaldo: false }) : null;
    if (!f) fallo(ctx, 'totp', 'mfa_codigos_fallido', 'Contraseña o código incorrectos.');
    return tx(ctx.db, () => {
      consumirSegundoFactor(ctx, f);
      audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'mfa_codigos_regenerados' });
      return { codigos: generarCodigos(ctx) };
    });
  }],

  ['GET', '/api/auth/sesiones', {}, ctx => ctx.db.prepare('SELECT substr(id, 1, 12) AS id, ip, ua, created_at, last_seen FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ? ORDER BY last_seen DESC')
    .all(ctx.user.id, Date.now()).map(s => ({ ...s, actual: ctx.sess.id.startsWith(s.id) }))],
  ['POST', '/api/auth/sesiones/:sid/revocar', {}, ctx => {
    if (!/^[0-9a-f]{12}$/.test(ctx.params.sid)) fail(400, 'Sesión inválida.');
    ctx.db.prepare("UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND substr(id, 1, 12) = ?").run(ctx.user.id, ctx.params.sid);
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'sesion_revocada' });
    return { ok: true };
  }],
  ['POST', '/api/auth/sesiones/cerrar-otras', {}, ctx => {
    const n = revocarSesionesDe(ctx.db, ctx.user.id, ctx.sess.id);
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'sesiones_cerradas', detalle: { cerradas: n } });
    return { cerradas: n };
  }],
];
