// Genera la demostración estática (para GitHub Pages) en docs/.
// Requisitos: servidor corriendo con la base demo (node server/seed.mjs; node server/index.mjs) y esbuild (npx).
// Uso: node scripts/build-demo.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs');
const BASE = process.env.BASE || 'http://127.0.0.1:4300';
const creds = Object.fromEntries(readFileSync(join(ROOT, 'data/credenciales-demo.txt'), 'utf8').split('\n').filter(l => l.includes('@')).map(l => { const p = l.trim().split(/\s+/); return [p[p.length - 2], p[p.length - 1]]; }));

const pad = n => String(n).padStart(2, '0');
const d = new Date();
const H = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const P = H.slice(0, 7), Y = H.slice(0, 4);
const addM = (p, n) => { const [y, m] = p.split('-').map(Number); const t = y * 12 + m - 1 + n; return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}`; };

// sesión de administración
const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@indiviso.test', password: creds['admin@indiviso.test'] }) });
const cookie = lr.headers.get('set-cookie').split(';')[0];
const snap = {};
const g = async p => { try { const r = await fetch(BASE + p, { headers: { cookie } }); if (!r.ok) return null; return (snap[p] = await r.json()); } catch { return null; } };

const me = await g('/api/auth/me');
me.csrf = 'demo';
await g('/api/consolidado?periodo=' + P);
snap['/api/auth/sesiones'] = [{ id: 'demo00000000', ip: '—', ua: 'Navegador (demostración)', created_at: Date.now() - 3600000, last_seen: Date.now(), actual: true }];
await g('/api/admin/respaldos');

for (const c of me.condominios) {
  const b = `/api/c/${c.id}`;
  await g(`${b}/tablero?periodo=${P}`);
  const us = await g(`${b}/unidades`);
  for (const u of us) {
    await g(`${b}/unidades/${u.id}`);
    await g(`${b}/cargos?unidad=${u.id}`);
    await g(`${b}/estado-cuenta/${u.id}?desde=${addM(P, -11)}-01&hasta=${H}`);
    await g(`${b}/estado-cuenta/${u.id}?desde=${P}-01&hasta=${H}`);
    if (u.adeudo > 0 || u.vencido > 0) await g(`${b}/constancia/${u.id}`);
  }
  await g(`${b}/estados-cuenta?desde=${P}-01&hasta=${H}`);
  await g(`${b}/morosidad?corte=${H}`);
  const pagos = await g(`${b}/pagos?desde=${addM(P, -1)}-01&hasta=${H}`);
  for (const p of pagos.filter(x => x.folio && x.estado === 'aplicado').slice(0, 150)) await g(`${b}/pagos/${p.id}/recibo`);
  await g(`${b}/pagos?estado=por_validar`);
  for (const q of [`desde=${addM(P, -2)}-01&hasta=${H}`, `estado=por_aprobar`, `estado=aprobado&desde=${addM(P, -2)}-01&hasta=${H}`]) await g(`${b}/egresos?${q}`);
  for (const r of ['proveedores', 'emisiones', 'config', 'convenios', 'cuentas', 'presupuestos', 'periodos', 'integridad', 'usuarios', 'personas']) await g(`${b}/${r}`);
  await g(`${b}/auditoria?limit=200`);
  const bancos = await g(`${b}/bancos`);
  for (const k of bancos) {
    await g(`${b}/bancos/${k.id}/movimientos?estado=pendientes`);
    const todos = await g(`${b}/bancos/${k.id}/movimientos`);
    for (const m of (todos || []).filter(x => !x.conciliado_tipo).slice(0, 20)) await g(`${b}/banco-movs/${m.id}/candidatos`);
  }
  for (const p of snap[`${b}/presupuestos`]) await g(`${b}/presupuestos/${p.id}`);
  for (const per of [P, addM(P, -1)]) {
    const pol = await g(`${b}/polizas?periodo=${per}`);
    for (const x of pol || []) await g(`${b}/polizas/${x.id}`);
  }
  const cxc = snap[`${b}/cuentas`].find(k => k.clave === 'CXC');
  await g(`${b}/reportes/mayor?cuenta=${cxc.id}&desde=${Y}-01&hasta=${P}`);
  await g(`${b}/reportes/balanza?desde=${P}&hasta=${P}`);
  await g(`${b}/reportes/resultados?desde=${Y}-01&hasta=${P}`);
  await g(`${b}/reportes/balance?hasta=${P}`);
  await g(`${b}/reportes/flujo?desde=${Y}-01&hasta=${P}`);
  await g(`${b}/reportes/fondo-reserva?desde=${Y}-01&hasta=${P}`);
  await g(`${b}/reportes/anual?ejercicio=${Y}`);
  const abierto = (snap[`${b}/periodos`] || []).filter(x => x.estado === 'abierto' && x.periodo < P).map(x => x.periodo).sort()[0];
  if (abierto) await g(`${b}/periodos/${abierto}/checklist`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'demo-data.js'), 'window.__DEMO=' + JSON.stringify({ me, snap, generado: H }) + ';\n');
execFileSync('npx', ['-y', 'esbuild', join(ROOT, 'public/js/app.js'), '--bundle', '--format=iife', '--target=es2022', '--minify', `--outfile=${join(OUT, 'app.js')}`], { stdio: 'inherit' });
copyFileSync(join(ROOT, 'public/css/app.css'), join(OUT, 'app.css'));
copyFileSync(join(ROOT, 'public/js/charts.js'), join(OUT, 'charts.js'));
copyFileSync(join(ROOT, 'public/favicon.svg'), join(OUT, 'favicon.svg'));
writeFileSync(join(OUT, '.nojekyll'), '');

writeFileSync(join(OUT, 'demo-shim.js'), `// Demostración estática: sirve las lecturas desde una copia de los datos demo; no guarda cambios.
(() => {
  const D = window.__DEMO, real = window.fetch.bind(window);
  const MSG = 'Versión de demostración de solo lectura: los cambios no se guardan. Instale el servidor (ver README) para operar.';
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const porRuta = {};
  for (const k of Object.keys(D.snap)) { const p = k.split('?')[0]; (porRuta[p] ??= k); }
  window.fetch = async (url, opts = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const i = u.indexOf('/api/');
    if (i < 0) return real(url, opts);
    const path = u.slice(i);
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (path === '/api/auth/me') return json(D.me);
      const hit = D.snap[path] ?? D.snap[porRuta[path.split('?')[0]]];
      return hit !== undefined ? json(hit) : json({ error: 'Este dato no está incluido en la demostración.' }, 404);
    }
    if (path === '/api/auth/login') return json({ mfa: false });
    if (path === '/api/auth/logout') return json({ ok: true });
    return json({ error: MSG, code: 'DEMO' }, 403);
  };
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Demostración · solo lectura · datos ficticios';
    b.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:60;padding:6px 10px;border-radius:6px;background:#14241f;color:#f4f4f1;font:500 12px system-ui;opacity:.92;pointer-events:none');
    document.body.appendChild(b);
  });
})();
`);

let html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  .replace('href="/favicon.svg"', 'href="favicon.svg"')
  .replace('href="/css/app.css"', 'href="app.css"')
  .replace('<script src="/js/charts.js" defer></script>\n<script type="module" src="/js/app.js"></script>',
    '<script src="demo-data.js" defer></script>\n<script src="demo-shim.js" defer></script>\n<script src="charts.js" defer></script>\n<script src="app.js" defer></script>');
writeFileSync(join(OUT, 'index.html'), html);
console.log(`Demo estática lista en ${OUT} · ${Object.keys(snap).length} respuestas · corte ${H}`);
