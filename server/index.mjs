// Indiviso CMS · servidor HTTP sin dependencias externas.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.mjs';
import { AppError } from './util.mjs';
import { authRoutes, loadSession, checkCsrf, checkOrigin } from './auth.mjs';
import { apiRoutes, resolverCondominio } from './api.mjs';
import { programarRespaldos } from './backup.mjs';

const PORT = +(process.env.PORT || 4300);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.INDIVISO_HTTPS === '1';      // detrás de un proxy TLS (Caddy/Nginx)
const TRUST_PROXY = process.env.INDIVISO_TRUST_PROXY === '1';
const PUBLIC = join(import.meta.dirname, '..', 'public');

const db = openDb();

const routes = [...authRoutes, ...apiRoutes].map(([method, path, opts, handler]) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, opts, handler };
});

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

function headers(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, 'La solicitud es demasiado grande.');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'Se esperaba JSON.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'JSON inválido.'); }
}

// Traduce errores de la base (restricciones, triggers) a mensajes claros sin filtrar internos.
function dbError(e) {
  const m = String(e.message || '');
  if (m.includes('INMUTABLE')) return new AppError(409, m.slice(m.indexOf('INMUTABLE') + 11) || 'Registro inmutable.', 'INMUTABLE');
  if (m.includes('PERIODO_CERRADO')) return new AppError(409, 'El periodo contable está cerrado; el movimiento no puede registrarse en esa fecha.', 'PERIODO_CERRADO');
  if (m.includes('UNIQUE constraint failed')) return new AppError(409, 'El registro ya existe (se evitó un duplicado).', 'DUPLICADO');
  if (m.includes('CHECK constraint failed')) return new AppError(400, 'Los datos no cumplen las reglas de validación.', 'VALIDACION');
  if (m.includes('FOREIGN KEY constraint failed')) return new AppError(400, 'Referencia a un registro inexistente.', 'REFERENCIA');
  return null;
}

async function api(req, res, url) {
  const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'Recurso no encontrado' });
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  const ctx = { req, res, db, ip, secure: SECURE, query: url.searchParams, params: {}, body: {} };
  const m = url.pathname.match(route.re);
  route.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
  try {
    if (req.method !== 'GET') { checkOrigin(ctx); ctx.body = await readBody(req, route.opts.limite || 1_000_000); }
    if (!route.opts.publico) {
      loadSession(ctx);
      if (!ctx.user) throw new AppError(401, 'Sesión no válida o expirada.', 'SESION');
      if (!ctx.sess.mfa_ok && !route.opts.mfaPendiente) throw new AppError(401, 'Falta la verificación en dos pasos.', 'MFA');
      if (req.method !== 'GET') checkCsrf(ctx);
      if (ctx.params.cid) resolverCondominio(ctx, route.opts.perm);
    }
    const out = await route.handler(ctx);
    if (out?.__file) {
      const { path, name, mime } = out.__file;
      const st = await stat(path);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return createReadStream(path).pipe(res);
    }
    if (out?.__raw) {
      res.writeHead(200, { 'Content-Type': out.__raw.mime, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${out.__raw.name}"` });
      return res.end(out.__raw.body);
    }
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    const err = e instanceof AppError ? e : dbError(e);
    if (err) return send(res, err.status, { error: err.message, code: err.code });
    const ref = randomBytes(4).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${url.pathname}`, e);
    send(res, 500, { error: `Error interno (ref. ${ref}).` });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/') || !extname(p)) p = '/index.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'no-cache, max-age=0' });
    res.end(data);
  } catch { res.writeHead(404); res.end('No encontrado'); }
}

const server = createServer((req, res) => {
  headers(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return estatico(req, res, url);
});
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.listen(PORT, HOST, () => {
  console.log(`Indiviso CMS escuchando en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!db.prepare('SELECT 1 FROM usuarios LIMIT 1').get()) console.log('Base vacía: ejecute «node server/seed.mjs» (demo) o «node server/seed.mjs --vacio» (solo superadministrador).');
});
programarRespaldos(db);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close(); } catch { /* cerrada */ } process.exit(0); });
