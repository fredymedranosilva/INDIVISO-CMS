// Apoyo para pruebas por HTTP: arranca el servidor real en un puerto libre con una base temporal
// y ofrece un cliente que conserva la cookie de sesión y el token CSRF, como lo hace el navegador.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const RAIZ = join(import.meta.dirname, '..');

export const puertoLibre = () => new Promise((ok, ko) => {
  const s = createServer();
  s.once('error', ko);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

export async function servidor(data, env = {}) {
  const port = await puertoLibre();
  const proc = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], { cwd: RAIZ, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', INDIVISO_DATA: data, INDIVISO_RATE: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const salida = [];
  proc.stderr.on('data', d => salida.push(String(d)));
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error('El servidor no arrancó: ' + salida.join(''))), 15000);
    proc.stdout.on('data', d => { salida.push(String(d)); if (String(d).includes('escuchando')) { clearTimeout(t); ok(); } });
    proc.once('exit', c => { clearTimeout(t); ko(new Error(`El servidor terminó (${c}): ${salida.join('')}`)); });
  });
  return { url: `http://127.0.0.1:${port}`, port, proc, salida, vivo: () => proc.exitCode === null, parar: () => new Promise(ok => { if (proc.exitCode !== null) return ok(); proc.once('exit', ok); proc.kill(); }) };
}

// Petición HTTP sin procesar (permite cabeceras que fetch no deja fijar, como Host) y rutas sin normalizar.
export const crudo = (port, { method = 'GET', path = '/', headers = {}, body = null } = {}) => new Promise((ok, ko) => {
  const r = request({ host: '127.0.0.1', port, method, path, headers, setHost: false }, res => {
    const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(ch).toString('utf8') }));
  });
  r.on('error', ko);
  if (body != null) r.write(body);
  r.end();
});

export class Cliente {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; this.me = null; }
  async req(method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = h['content-type'] || 'application/json';
    if (method !== 'GET' && csrf && this.csrf) h['x-csrf-token'] = this.csrf;
    const r = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); if (k === 'idv_s') this.cookie = v ? `idv_s=${v}` : ''; }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* no es JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  put(p, b = {}, o) { return this.req('PUT', p, b, o); }
  del(p, o) { return this.req('DELETE', p, {}, o); }
  async sesion() { const me = await this.get('/api/auth/me'); if (me.status === 200) { this.csrf = me.json.csrf; this.me = me.json; } return me; }
  async login(email, password) { const r = await this.post('/api/auth/login', { email, password }); if (r.status === 200) await this.sesion(); return r; }
  // Exige 200 y devuelve el JSON; en otro caso lanza con el detalle (para escenarios).
  async ok(method, path, body) {
    const r = await this.req(method, path, method === 'GET' ? undefined : body ?? {});
    if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }
}

export const idem = () => 'T' + Math.random().toString(36).slice(2) + Date.now().toString(36) + 'xxxxxxxx';
// PDF mínimo válido para probar subidas
export const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');
