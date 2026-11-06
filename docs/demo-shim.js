// Demostración estática: sirve las lecturas desde una copia de los datos demo; no guarda cambios.
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
