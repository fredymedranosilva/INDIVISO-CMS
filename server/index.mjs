// Indiviso CMS · servidor HTTP sin dependencias externas.
// Cada petición pasa por: validación del Host, cabeceras de seguridad, límite de frecuencia,
// sesión + 2FA + CSRF, permiso de la ruta y aislamiento por condominio. Ningún error tumba el proceso.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { openDb } from './db.mjs';
import { AppError, dbError } from './util.mjs';
import { authRoutes, loadSession, checkCsrf, checkOrigin, limpiarSesiones } from './auth.mjs';
import { apiRoutes, resolverCondominio } from './api.mjs';
import { programarRespaldos } from './backup.mjs';
import { rateLimit, audit, hashPassword, passwordProblem, token } from './security.mjs';
import { writeFileSync } from 'node:fs';
import { DATA_DIR } from './db.mjs';
import { TEMPORAL_MS } from './auth.mjs';

const PORT = +(process.env.PORT || 4300);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.INDIVISO_HTTPS === '1';      // detrás de un proxy TLS (Caddy/Nginx)
const TRUST_PROXY = process.env.INDIVISO_TRUST_PROXY === '1';
// Nombres de host aceptados (separados por coma). Sin lista y escuchando solo en esta máquina, se aceptan
// únicamente localhost/127.0.0.1: así un sitio malicioso no puede alcanzar el servidor con un dominio propio (DNS rebinding).
const HOSTS = (process.env.INDIVISO_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const RATE = process.env.INDIVISO_RATE === undefined ? 1200 : +process.env.INDIVISO_RATE; // peticiones por minuto e IP a la API (0 = sin límite)
const PUBLIC = join(import.meta.dirname, '..', 'public');

const db = openDb();

// Primer arranque en un servidor nuevo: crea el superadministrador. Con INDIVISO_ADMIN_EMAIL e INDIVISO_ADMIN_PASSWORD
// usa esos datos; sin contraseña genera una temporal (7 días, se cambia al entrar) y la deja en DATA_DIR/primer-acceso.txt.
function primerArranque() {
  if (db.prepare('SELECT 1 FROM usuarios LIMIT 1').get()) return;
  const email = (process.env.INDIVISO_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return; // sin variable: el superadministrador se crea desde la pantalla de instalación
  let pass = process.env.INDIVISO_ADMIN_PASSWORD || '', temporal = false;
  if (pass && passwordProblem(pass, email)) { console.error(`INDIVISO_ADMIN_PASSWORD no es válida: ${passwordProblem(pass, email)} Se generará una temporal.`); pass = ''; }
  if (!pass) { pass = `${token(9)}-Aa1`; temporal = true; }
  const now = Date.now();
  const id = Number(db.prepare('INSERT INTO usuarios (email, nombre, pass_hash, superadmin, debe_cambiar_pass, pass_temporal_hasta, created_at, pass_cambiado_at) VALUES (?,?,?,1,?,?,?,?)')
    .run(email, process.env.INDIVISO_ADMIN_NOMBRE || 'Superadministrador', hashPassword(pass), temporal ? 1 : 0, temporal ? now + TEMPORAL_MS : null, now, now).lastInsertRowid);
  audit(db, { usuario_id: id, accion: 'instalacion' });
  if (temporal) {
    const f = join(DATA_DIR, 'primer-acceso.txt');
    writeFileSync(f, `Indiviso CMS · primer acceso\n\nCorreo: ${email}\nContraseña temporal (válida 7 días, se cambia al entrar): ${pass}\n\nBorre este archivo después de entrar.\n`, { mode: 0o600 });
    console.log(`Superadministrador creado: ${email} · contraseña temporal: ${pass} (también en ${f}). Cámbiela al entrar.`);
  } else console.log(`Superadministrador creado: ${email}. Quite INDIVISO_ADMIN_PASSWORD de las variables de entorno.`);
}
primerArranque();

const routes = [...authRoutes, ...apiRoutes].map(([method, path, opts, handler]) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, opts, handler };
});

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
  "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ...(SECURE ? ['upgrade-insecure-requests'] : [])].join('; ');

function headers(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function hostPermitido(req) {
  const h = String(req.headers.host || '').toLowerCase();
  if (!h || h.length > 255) return false;
  const nombre = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  if (HOSTS.length) {
    const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase() : '';
    return [h, nombre, fwd, fwd.split(':')[0]].some(x => x && HOSTS.includes(x));
  }
  if (LOCAL) return ['localhost', '127.0.0.1', '[::1]'].includes(nombre);
  return true; // expuesto en red sin INDIVISO_HOSTS: se acepta y se advierte al arrancar
}

function ipDe(req) {
  if (TRUST_PROXY) {
    // El proxy de confianza agrega la IP real al final de la lista; lo anterior lo controla el cliente.
    const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xs.length) return xs[xs.length - 1].slice(0, 64);
  }
  return req.socket.remoteAddress || '';
}

async function readBody(req, limit) {
  const declarado = +req.headers['content-length'];
  if (declarado > limit) throw new AppError(413, 'La solicitud es demasiado grande.');
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, 'La solicitud es demasiado grande.');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError(415, 'Se esperaba JSON.');
  let j;
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'JSON inválido.'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new AppError(400, 'Se esperaba un objeto JSON.');
  return j;
}

const decodificar = s => { try { return decodeURIComponent(s); } catch { throw new AppError(400, 'Dirección inválida.'); } };

async function api(req, res, url) {
  const ip = ipDe(req);
  if (RATE && !rateLimit('api:' + ip, RATE, 60000)) return send(res, 429, { error: 'Demasiadas solicitudes. Espere un momento.' }, { 'Retry-After': '30' });
  // Los navegadores declaran de dónde sale la petición: la API solo se usa desde la propia aplicación.
  const sitio = req.headers['sec-fetch-site'];
  if (sitio === 'cross-site' || (sitio === 'same-site' && req.method !== 'GET')) return send(res, 403, { error: 'Origen no permitido.', code: 'ORIGEN' });
  const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'Recurso no encontrado' });
  const ctx = { req, res, db, ip, secure: SECURE || (TRUST_PROXY && /^https/i.test(String(req.headers['x-forwarded-proto'] || ''))), query: url.searchParams, params: {}, body: {} };
  try {
    const m = url.pathname.match(route.re);
    route.keys.forEach((k, i) => { ctx.params[k] = decodificar(m[i + 1]); });
    if (req.method !== 'GET') { checkOrigin(ctx); ctx.body = await readBody(req, route.opts.limite || 1_000_000); }
    if (!route.opts.publico) {
      loadSession(ctx);
      if (!ctx.user) throw new AppError(401, 'Sesión no válida o expirada.', 'SESION');
      if (!ctx.sess.mfa_ok && !route.opts.mfaPendiente) throw new AppError(401, 'Falta la verificación en dos pasos.', 'MFA');
      if (req.method !== 'GET') checkCsrf(ctx);
      if (ctx.user.debe_cambiar_pass && !route.opts.cambioPendiente) throw new AppError(403, 'Cambie su contraseña temporal para continuar.', 'CAMBIO_PASSWORD');
      if (ctx.params.cid) resolverCondominio(ctx, route.opts.perm);
    }
    const out = await route.handler(ctx);
    if (out?.__file) {
      const { path, name, mime, inline } = out.__file;
      const st = await stat(path);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return createReadStream(path).on('error', () => res.destroy()).pipe(res);
    }
    if (out?.__raw) {
      res.writeHead(200, { 'Content-Type': out.__raw.mime, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.__raw.name)}"` });
      return res.end(out.__raw.body);
    }
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    const err = e instanceof AppError ? e : dbError(e);
    if (err) {
      // Los intentos sin permiso quedan en la bitácora (acotados para que no la inunden).
      if (err.status === 403 && ctx.user && rateLimit('aud403:' + ctx.user.id, 30, 3600000)) {
        try { audit(db, { usuario_id: ctx.user.id, condominio_id: ctx.cid ?? null, ip, accion: 'acceso_denegado', detalle: { ruta: `${req.method} ${url.pathname}`.slice(0, 160), motivo: err.code || null } }); } catch { /* la bitácora no debe ocultar el error original */ }
      }
      return send(res, err.status, { error: err.message, code: err.code });
    }
    const ref = randomBytes(4).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${url.pathname}`, e);
    if (!res.headersSent) send(res, 500, { error: `Error interno (ref. ${ref}).` });
    else res.destroy();
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const cacheEstatico = new Map(); // ruta → { mtime, data, etag }

async function estatico(req, res, url) {
  let p = decodificar(url.pathname);
  if (p.includes('\0')) { res.writeHead(400); return res.end(); }
  if (p.endsWith('/') || !extname(p)) p = '/index.html';
  const file = normalize(join(PUBLIC, p));
  // Solo archivos de la aplicación: dentro de public/, con extensión conocida y sin archivos ocultos.
  if (!file.startsWith(PUBLIC + sep) || !TYPES[extname(file)] || file.split(sep).some(s => s.startsWith('.'))) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('no es archivo');
    let c = cacheEstatico.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const data = await readFile(file);
      c = { mtime: st.mtimeMs, data, etag: `"${createHash('sha256').update(data).digest('base64url').slice(0, 22)}"` };
      cacheEstatico.set(file, c);
    }
    const h = { 'Content-Type': TYPES[extname(file)], 'Cache-Control': extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: c.etag };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end(); }
    res.writeHead(200, { ...h, 'Content-Length': c.data.length });
    res.end(req.method === 'HEAD' ? undefined : c.data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); }
}

async function atender(req, res) {
  headers(res);
  if (!hostPermitido(req)) { res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Host no permitido'); }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  return estatico(req, res, url);
}

const server = createServer((req, res) => {
  atender(req, res).catch(e => {
    const status = e instanceof AppError ? e.status : 500;
    if (status === 500) console.error('[error]', req.method, req.url, e);
    try { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(status === 500 ? 'Error interno' : e.message); } catch { res.destroy(); }
  });
});
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 10000;
server.maxHeadersCount = 100;
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

// Un error inesperado se registra, pero no detiene el servicio.
process.on('unhandledRejection', e => console.error('[rechazo no controlado]', e));
process.on('uncaughtException', e => console.error('[excepción no controlada]', e));

server.listen(PORT, HOST, () => {
  console.log(`Indiviso CMS escuchando en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!LOCAL && !HOSTS.length) console.warn('AVISO: el servidor acepta conexiones de la red sin lista de hosts. Defina INDIVISO_HOSTS=su.dominio.com');
  if (!LOCAL && !SECURE) console.warn('AVISO: expuesto en red sin HTTPS. Póngalo detrás de un proxy TLS y defina INDIVISO_HTTPS=1.');
  if (!db.prepare('SELECT 1 FROM usuarios LIMIT 1').get()) console.log('Base vacía: abra el sistema en el navegador para crear al superadministrador.');
});
programarRespaldos(db);
limpiarSesiones(db);
setInterval(() => { try { limpiarSesiones(db); } catch (e) { console.error('[sesiones]', e.message); } }, 3600000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close(); } catch { /* cerrada */ } process.exit(0); });
