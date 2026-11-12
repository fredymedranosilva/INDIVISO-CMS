// Demostración estática: sirve las lecturas desde una copia de los datos demo; no guarda cambios.
(() => {
  const D = window.__DEMO, real = window.fetch.bind(window);
  const MSG = 'Versión de demostración de solo lectura: los cambios no se guardan. Instale el servidor (ver README) para operar.';
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const porRuta = {};
  for (const k of Object.keys(D.snap)) { const p = k.split('?')[0]; (porRuta[p] ??= k); }
  // Búsqueda global sobre los datos de la demostración (misma forma de respuesta que el servidor).
  const plano = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const juntar = (cid, re) => { const m = new Map(); for (const [k, v] of Object.entries(D.snap)) if (re.test(k.replace('/api/c/' + cid, '')) && Array.isArray(v)) for (const x of v) m.set(x.id, x); return [...m.values()]; };
  function buscar(cid, t) {
    t = t.trim().slice(0, 60); const vacio = { unidades: [], personas: [], pagos: [], egresos: [], proveedores: [] };
    if (t.length < 2) return vacio;
    const n = plano(t), folio = +(/^(?:[RE][- ]?)?(\d{1,9})$/i.exec(t)?.[1] ?? -1), b = '/api/c/' + cid;
    const us = D.snap[b + '/unidades'] || [], idDe = Object.fromEntries(us.map(u => [u.clave, u.id]));
    const personas = (D.snap[b + '/personas'] || []).filter(p => plano(p.nombre).includes(n) || plano(p.email).includes(n))
      .map(p => { const cl = String(p.unidades || '').split(', ').map(x => x.split(':')[0]); return { ...p, unidades: cl.join(', '), unidad_id: idDe[cl[0]] ?? null }; });
    const unidades = us.filter(u => [u.clave, u.referencia, u.propietario, u.personas, (u.torre || '') + ' ' + u.clave].some(x => plano(x).includes(n))).slice(0, 6);
    const proveedores = (D.snap[b + '/proveedores'] || []).filter(p => [p.nombre, p.rfc, p.giro].some(x => plano(x).includes(n))).slice(0, 5);
    const pagos = juntar(cid, /^\/pagos\?/).filter(p => p.folio === folio || plano(p.referencia).includes(n)).sort((a, z) => z.fecha.localeCompare(a.fecha)).slice(0, 6);
    const egresos = juntar(cid, /^\/egresos\?/).filter(e => e.folio === folio || [e.concepto, e.proveedor, e.factura_folio].some(x => plano(x).includes(n))).sort((a, z) => z.fecha.localeCompare(a.fecha)).slice(0, 6);
    return { unidades, personas: personas.slice(0, 6), pagos, egresos, proveedores };
  }
  window.fetch = async (url, opts = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const i = u.indexOf('/api/');
    if (i < 0) return real(url, opts);
    const path = u.slice(i);
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (path === '/api/auth/me') return json(D.me);
      const mb = /^\/api\/c\/(\d+)\/buscar\?q=([^&]*)/.exec(path);
      if (mb) return json(buscar(mb[1], decodeURIComponent(mb[2])));
      const hit = D.snap[path] ?? D.snap[porRuta[path.split('?')[0]]];
      return hit !== undefined ? json(hit) : json({ error: 'Este dato no está incluido en la demostración.' }, 404);
    }
    if (path === '/api/auth/login') return json({ mfa: false });
    if (path === '/api/auth/logout') return json({ ok: true });
    return json({ error: MSG, code: 'DEMO' }, 403);
  };
  // Publicada en claude.ai la página no puede descargar por sí misma: entrega el archivo con la capacidad «downloads».
  let dl = null;
  window.__guardarArchivo = async (blob, nombre) => {
    if (!window.claude || typeof window.claude.use !== 'function') return false;
    dl = dl || window.claude.use('downloads');
    const d = await dl;
    if (!d) return false;
    try { await d.save({ filename: nombre, data: blob }); }
    catch (e) { if (e && e.code === 'declined') return true; throw new Error('No se pudo descargar el archivo (' + ((e && e.code) || 'error') + ').'); }
    return true;
  };
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Demostración · solo lectura · datos ficticios';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;padding:6px 10px;border-radius:6px;background:#14241f;color:#f4f4f1;font:500 12px system-ui;opacity:.92;pointer-events:none';
    document.body.appendChild(b);
  });
})();
