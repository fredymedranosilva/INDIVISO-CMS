// Documentos PDF: reportes de ingresos, egresos, cuentas por cobrar, saldos bancarios, conciliación y morosidad,
// estados de cuenta, recibos y avisos de cobro. Se generan en el navegador con gráficas vectoriales.
import { PDF } from './pdf.js';
import { guardarBlob } from './xlsx.js';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MES3 = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
export const PALETA = ['#1b6fb5', '#f28c38', '#9fcbe9', '#0f8a84', '#f6b951', '#e8596b', '#8c6bc8', '#5bbf63', '#bfc5cc', '#2f4858', '#ff7f50', '#6bc3f0', '#b0855a', '#a1c935', '#d17bd1', '#3d5a80'];
const TINTA = '#1f2933', SUAVE = '#6b7280', LINEA = '#e5e7eb', BORDE = '#d1d5db', VERDE = '#1e9e48', ROJO = '#c53030';
export const COLORES = { ingresos: '#2b8be6', egresos: '#f39248', bancos: '#4a7ee6', conciliacion: '#14857a', cxc: '#7a5cc7', morosidad: '#d64545', cuenta: '#178fb3' };

export const dinero = c => `${c < 0 ? '-' : ''}$${(Math.abs(c || 0) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dmy = f => f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : '—';
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mesNombre = p => `${MESES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
const pct = (a, b, d = 2) => b ? `${(a / b * 100).toFixed(d)}%` : '0%';
const compacto = v => { const a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)} M` : a >= 1e3 ? `${Math.round(v / 1e3)} mil` : String(Math.round(v)); };
const claro = hex => { const h = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); return (0.299 * r + 0.587 * g + 0.114 * b) > 150; };
const aclarar = (hex, t = 0.55) => '#' + [0, 2, 4].map(i => Math.round(parseInt(hex.slice(1 + i, 3 + i), 16) + (255 - parseInt(hex.slice(1 + i, 3 + i), 16)) * t).toString(16).padStart(2, '0')).join('');
function ticks(max, n = 5) {
  if (max <= 0) return [0, 1];
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = []; for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

// ---------- Documento con encabezado, pie y paginación ----------
// Logotipo del condominio para los PDF: se convierte a JPEG (fondo blanco) una sola vez por condominio.
const logos = new Map();
export async function cargarLogo(condominio) {
  if (!(condominio?.logo || condominio?.logo_archivo_id) || !condominio.id || typeof document === 'undefined') return null;
  if (logos.has(condominio.id)) return logos.get(condominio.id);
  const prom = (async () => {
    try {
      const r = await fetch(`/api/c/${condominio.id}/logo`, { credentials: 'same-origin' });
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
      const cv = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
      const jpg = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.9));
      return { jpeg: new Uint8Array(await jpg.arrayBuffer()), px: cv.width, py: cv.height };
    } catch { return null; }
  })();
  logos.set(condominio.id, prom);
  return prom;
}

export class Informe {
  constructor({ condominio, titulo, periodo, color = COLORES.ingresos, etiqueta, logo = null }) {
    this.logo = logo;
    this.pdf = new PDF(); this.W = this.pdf.W; this.H = this.pdf.H;
    this.M = 40; this.CW = this.W - 80; this.limite = this.H - 66;
    this.documento({ condominio, titulo, periodo, color, etiqueta });
  }
  documento({ condominio, titulo, periodo, color, etiqueta = 'Periodo de consulta: ' }) {
    Object.assign(this, { c: condominio || {}, titulo, periodo, color, etiqueta });
    this.nueva(true);
  }
  nueva(primera = false) {
    const p = this.pdf, M = this.M;
    p.pagina();
    p.rect(M, 26, this.CW, 9, { fill: this.color, r: 4.5, arriba: true });
    if (primera) {
      if (this.logo) { // logotipo del condominio, a lo más 120 × 48 pt
        const k = Math.min(120 / this.logo.px, 48 / this.logo.py);
        p.imagen(this.logo.jpeg, this.logo.px, this.logo.py, this.logo.px, this.logo.py, M, 48, this.logo.px * k, this.logo.py * k);
      } else {
      // marca: monograma del condominio
      p.rect(M, 52, 40, 40, { fill: '#0f1b2d', r: 8 });
      p.trazo([[M + 10, 82], [M + 10, 64], [M + 20, 59], [M + 30, 64], [M + 30, 82]], { color: '#ffffff', lw: 1.6 });
      p.linea(M + 20, 59, M + 20, 82, { color: '#ffffff', lw: 1.6 });
      p.rect(M + 20.8, 71, 8.4, 10.2, { fill: '#2dd4bf' });
      }
      const x = this.W - M;
      p.texto(this.c.nombre || 'Condominio', x, 64, { size: 15, bold: true, align: 'right', color: '#111827', max: this.CW - 60 });
      p.texto(this.titulo, x, 82, { size: 12.5, align: 'right', color: '#111827' });
      if (this.periodo) {
        const w = p.ancho(this.periodo, 10.5, true);
        p.texto(this.periodo, x, 102, { size: 10.5, bold: true, align: 'right', color: '#111827' });
        p.texto(this.etiqueta, x - w, 102, { size: 10.5, align: 'right', color: '#111827' });
      }
      this.y = 124;
    } else {
      p.texto(`${this.c.nombre || ''} · ${this.titulo}`, this.W - M, 52, { size: 9, align: 'right', color: SUAVE, max: this.CW });
      this.y = 66;
    }
    this.marcas = (this.marcas || 0) + 1;
  }
  necesita(h) { if (this.y + h > this.limite) { this.nueva(); return true; } return false; }
  espacio(h = 10) { this.y += h; }
  seccion(t, sub) {
    this.necesita(sub ? 50 : 36);
    this.pdf.texto(t, this.M, this.y + 14, { size: 12, bold: true, color: '#111827' });
    if (sub) this.pdf.texto(sub, this.M, this.y + 28, { size: 8.5, color: SUAVE, max: this.CW });
    this.y += sub ? 38 : 24;
  }
  parrafo(t, { size = 9, color = TINTA, align = 'left', bold = false } = {}) {
    const lineas = this.pdf.partir(t, this.CW, size, bold);
    for (const l of lineas) {
      this.necesita(size + 5);
      const x = align === 'center' ? this.M + this.CW / 2 : align === 'right' ? this.M + this.CW : this.M;
      this.pdf.texto(l, x, this.y + size, { size, color, align, bold });
      this.y += size + 4;
    }
    this.y += 4;
  }
  tarjeta(h, { borde = BORDE } = {}) { const t = { x: this.M, y: this.y, w: this.CW, h }; this.pdf.rect(t.x, t.y, t.w, t.h, { stroke: borde, lw: 0.8, r: 8 }); this.y += h + 14; return t; }

  // Recuadros de cifras clave
  kpis(items) {
    const n = items.length, g = 10, w = (this.CW - g * (n - 1)) / n, h = 52;
    this.necesita(h + 14);
    items.forEach((k, i) => {
      const x = this.M + i * (w + g);
      this.pdf.rect(x, this.y, w, h, { stroke: BORDE, lw: 0.8, r: 6 });
      this.pdf.rect(x, this.y, 4, h, { fill: k.color || this.color, r: 2 });
      this.pdf.texto(k.label, x + 12, this.y + 18, { size: 8, color: SUAVE, max: w - 18 });
      this.pdf.texto(k.valor, x + 12, this.y + 38, { size: k.valor.length > 14 ? 11 : 13, bold: true, color: k.tinta || '#111827', max: w - 18 });
    });
    this.y += h + 14;
  }

  // Dona con porcentajes y leyenda
  dona(items, { alto = 230, formato = dinero, centro = 'Total' } = {}) {
    const datos = items.filter(i => i.valor > 0).map((d, i) => ({ ...d, color: d.color || PALETA[i % PALETA.length] }));
    const total = datos.reduce((a, d) => a + d.valor, 0);
    this.necesita(alto + 14);
    const t = this.tarjeta(alto), p = this.pdf;
    if (!total) { p.texto('Sin movimientos en el periodo', t.x + t.w / 2, t.y + alto / 2, { size: 10, color: SUAVE, align: 'center' }); return; }
    const cx = t.x + 140, cy = t.y + alto / 2, R = Math.min(92, alto / 2 - 16), r = R * 0.55;
    let a = 0;
    for (const d of datos) {
      const b = a + 2 * Math.PI * d.valor / total;
      p.sector(cx, cy, r, R, a, b - (datos.length > 1 ? 0.004 : 0), { fill: d.color });
      if (d.valor / total >= 0.05) {
        const m = (a + b) / 2, rr = (r + R) / 2;
        p.texto(pct(d.valor, total, 1), cx + rr * Math.sin(m), cy - rr * Math.cos(m) + 3, { size: 8, bold: true, align: 'center', color: claro(d.color) ? '#111827' : '#ffffff' });
      }
      a = b;
    }
    p.texto(formato(total), cx, cy + 2, { size: total >= 1e9 ? 8.5 : 9.5, bold: true, align: 'center', color: '#111827' });
    p.texto(centro, cx, cy + 14, { size: 7.5, align: 'center', color: SUAVE });
    const lx = t.x + 270, filas = Math.min(datos.length, Math.floor((alto - 24) / 17));
    let ly = cy - filas * 17 / 2 + 6;
    for (const d of datos.slice(0, filas)) {
      p.rect(lx, ly - 7, 9, 9, { fill: d.color, r: 2 });
      p.texto(d.label, lx + 15, ly, { size: 8.5, color: TINTA, max: 150 });
      p.texto(pct(d.valor, total, 1), lx + 180, ly, { size: 8.5, bold: true, color: TINTA, align: 'right' });
      p.texto(formato(d.valor), t.x + t.w - 14, ly, { size: 8.5, color: TINTA, align: 'right' });
      ly += 17;
    }
    if (datos.length > filas) p.texto(`… y ${datos.length - filas} más`, lx + 15, ly, { size: 8, color: SUAVE });
  }

  // Barras horizontales (clasificaciones); se reparte en varias tarjetas si no cabe
  barrasH(items, { formato = dinero, etiqueta = 175 } = {}) {
    const datos = items.map((d, i) => ({ ...d, color: d.color || PALETA[i % PALETA.length] }));
    if (!datos.length) return;
    const max = Math.max(...datos.map(d => d.valor), 0), tk = ticks(max), tope = tk[tk.length - 1] || 1, fila = 18;
    let i = 0;
    while (i < datos.length) {
      const libre = this.limite - this.y - 48;
      if (libre < fila * 3) { this.nueva(); continue; }
      const parte = datos.slice(i, i + Math.floor(libre / fila));
      const t = this.tarjeta(parte.length * fila + 44), p = this.pdf;
      const x0 = t.x + etiqueta + 12, x1 = t.x + t.w - 72, top = t.y + 14, base = top + parte.length * fila;
      for (const v of tk) {
        const x = x0 + (x1 - x0) * v / tope;
        p.linea(x, top - 4, x, base, { color: LINEA, lw: 0.5 });
        p.texto(compacto(v / 100), x, base + 13, { size: 7.5, color: SUAVE, align: 'center' });
      }
      parte.forEach((d, k) => {
        const y = top + k * fila;
        p.texto(d.label, x0 - 7, y + 12, { size: 8, color: '#4b5563', align: 'right', max: etiqueta });
        const w = Math.max(d.valor > 0 ? 1.5 : 0, (x1 - x0) * d.valor / tope);
        if (w) p.rect(x0, y + 3, w, 12, { fill: d.color, r: 1.5 });
        p.texto(formato(d.valor), x0 + w + 5, y + 12, { size: 8, color: TINTA });
      });
      i += parte.length;
    }
  }

  // Barras verticales agrupadas (mes con mes)
  barrasV(etiquetas, series, { alto = 210, formato = dinero } = {}) {
    this.necesita(alto + 14);
    const t = this.tarjeta(alto), p = this.pdf;
    const max = Math.max(1, ...series.flatMap(s => s.valores)), tk = ticks(max), tope = tk[tk.length - 1];
    let lx = t.x + 16;
    for (const s of series) { p.rect(lx, t.y + 12, 9, 9, { fill: s.color, r: 2 }); p.texto(s.nombre, lx + 13, t.y + 20, { size: 8, color: TINTA }); lx += p.ancho(s.nombre, 8) + 32; }
    const x0 = t.x + 48, x1 = t.x + t.w - 14, top = t.y + 36, base = t.y + alto - 26;
    for (const v of tk) {
      const y = base - (base - top) * v / tope;
      p.linea(x0, y, x1, y, { color: LINEA, lw: 0.5 });
      p.texto(compacto(v / 100), x0 - 5, y + 3, { size: 7.5, color: SUAVE, align: 'right' });
    }
    const gw = (x1 - x0) / etiquetas.length, bw = Math.min(16, gw * 0.78 / series.length);
    etiquetas.forEach((e, i) => {
      const gx = x0 + i * gw + (gw - bw * series.length) / 2;
      series.forEach((s, k) => {
        const h = (base - top) * (s.valores[i] || 0) / tope;
        if (h > 0) p.rect(gx + k * bw, base - h, bw - 1, h, { fill: s.color, r: 1 });
      });
      p.texto(e, x0 + i * gw + gw / 2, base + 13, { size: 7.5, color: SUAVE, align: 'center' });
    });
  }

  // Línea con área (saldos)
  lineaEn(x, y, w, h, etiquetas, valores, { color = '#3cc13b' } = {}) {
    const p = this.pdf;
    const mn0 = Math.min(...valores), mx0 = Math.max(...valores);
    let mn = mn0, mx = mx0;
    if (mn === mx) { const d = Math.max(Math.abs(mx) * 0.1, 100); mn -= d; mx += d; } else { const d = (mx - mn) * 0.12; mn -= d; mx += d; }
    if (mn0 >= 0 && mn < 0) mn = 0;
    const x0 = x + 50, x1 = x + w - 6, top = y + 4, base = y + h - 16;
    for (let k = 0; k <= 3; k++) {
      const v = mn + (mx - mn) * k / 3, yy = base - (base - top) * k / 3;
      p.linea(x0, yy, x1, yy, { color: LINEA, lw: 0.4 });
      p.texto(compacto(v / 100), x0 - 4, yy + 3, { size: 7, color, align: 'right' });
    }
    const pts = valores.map((v, i) => [x0 + (x1 - x0) * (valores.length === 1 ? 0.5 : i / (valores.length - 1)), base - (base - top) * (v - mn) / (mx - mn)]);
    p.trazo(pts, { fill: color, alfa: 0.35, suave: true, cerrar: [[pts[0][0], base], [pts[pts.length - 1][0], base]] });
    p.trazo(pts, { color, lw: 1.6, suave: true });
    for (const q of pts) p.circulo(q[0], q[1], 1.8, { fill: color });
    etiquetas.forEach((e, i) => { if (etiquetas.length <= 6 || i % 2 === 0 || i === etiquetas.length - 1) p.texto(e, pts[i][0], base + 12, { size: 7, color, align: 'center' }); });
  }

  // Tabla con salto de página y encabezado repetido.
  // cols: [{ t, w, align, wrap }]; filas: [...celdas] o { celdas, estilo: grupo|clasif|detalle|subtotal|total|banda, swatch, tintas }
  tabla(cols, filas, { size = 8.5, encabezado = true } = {}) {
    const p = this.pdf, M = this.M;
    const fijos = cols.reduce((a, c) => a + (c.w || 0), 0), libres = cols.filter(c => !c.w).length;
    const ws = cols.map(c => c.w || (this.CW - fijos) / libres);
    const xs = ws.map((_, i) => M + ws.slice(0, i).reduce((a, b) => a + b, 0));
    const cab = () => {
      if (!encabezado) return;
      this.necesita(24);
      p.rect(M, this.y, this.CW, 22, { fill: '#f3f4f6', r: 5, arriba: true });
      p.linea(M, this.y + 22, M + this.CW, this.y + 22, { color: BORDE, lw: 1 });
      cols.forEach((c, i) => p.texto(c.t, c.align === 'right' ? xs[i] + ws[i] - 7 : c.align === 'center' ? xs[i] + ws[i] / 2 : xs[i] + 7, this.y + 14.5, { size: 8, bold: true, color: '#374151', align: c.align || 'left', max: ws[i] - 10 }));
      this.y += 22;
    };
    cab();
    filas.forEach((f, n) => {
      const F = Array.isArray(f) ? { celdas: f } : f;
      const est = F.estilo || '', sz = F.size || size;
      const bold = ['grupo', 'clasif', 'total', 'banda', 'subtotal'].includes(est) || F.bold;
      const off = F.swatch ? 16 : 0;
      const lineas = F.celdas.map((c, i) => cols[i].wrap ? p.partir(c ?? '', ws[i] - 14 - (i === 0 ? off : 0), sz, bold) : [String(c ?? '')]);
      const h = Math.max(est === 'banda' ? 22 : sz < 8 ? 16 : 19, Math.max(...lineas.map(l => l.length)) * (sz + 3) + (sz < 8 ? 6 : 9));
      if (this.necesita(h)) cab();
      const y = this.y;
      if (est === 'banda') p.rect(M, y, this.CW, h, { fill: this.color, r: F.ultima ? 5 : 0, abajo: true });
      else if (est === 'total') p.rect(M, y, this.CW, h, { fill: aclarar(this.color, 0.55) });
      else if (est === 'detalle' || (F.zebra ?? (!est && n % 2 === 1))) p.rect(M, y, this.CW, h, { fill: '#f8f9fa' });
      if (est !== 'banda' && est !== 'total') p.linea(M, y + h, M + this.CW, y + h, { color: LINEA, lw: 0.6 });
      if (F.swatch) p.rect(xs[0] + 7, y + h / 2 - 5, 10, 10, { fill: F.swatch, r: 2.5 });
      F.celdas.forEach((c, i) => {
        const col = cols[i];
        let color = est === 'banda' ? '#ffffff' : est === 'subtotal' ? aclarar(this.color, 0.15) : (F.tintas?.[i] || (est === 'detalle' && col.monto ? VERDE : TINTA));
        const al = i === 0 && F.alinear0 ? F.alinear0 : col.align || 'left';
        const x = al === 'right' ? xs[i] + ws[i] - 7 : al === 'center' ? xs[i] + ws[i] / 2 : xs[i] + 7 + (i === 0 ? off : 0);
        lineas[i].forEach((l, k) => p.texto(l, x, y + (sz < 8 ? 6 : 9) + sz * 0.85 + k * (sz + 3), { size: sz, bold, color, align: al, max: col.wrap ? undefined : ws[i] - 10 }));
      });
      this.y += h;
    });
    this.y += 14;
  }

  // Lista de pares etiqueta–valor en dos columnas (encabezado de estado de cuenta, recibo)
  datos(pares, { columnas = 2, alto = 0 } = {}) {
    const p = this.pdf, w = this.CW / columnas, filas = Math.ceil(pares.length / columnas), h = alto || filas * 30 + 16;
    this.necesita(h + 14);
    const t = this.tarjeta(h);
    pares.forEach(([k, v, opc = {}], i) => {
      const col = i % columnas, fila = Math.floor(i / columnas);
      const x = t.x + 14 + col * w, y = t.y + 14 + fila * 30;
      p.texto(k, x, y + 8, { size: 7.5, color: SUAVE });
      p.texto(v ?? '—', x, y + 22, { size: opc.size || 10, bold: true, color: opc.color || '#111827', max: w - 24 });
    });
  }
  banda(texto, { size = 11 } = {}) {
    this.necesita(34);
    this.pdf.rect(this.M, this.y, this.CW, 28, { fill: this.color, r: 6 });
    this.pdf.texto(texto, this.M + this.CW / 2, this.y + 18.5, { size, bold: true, color: '#ffffff', align: 'center' });
    this.y += 40;
  }
  async guardar(nombre) {
    const p = this.pdf, n = p.numPaginas, f = dmy(hoyISO());
    const marca = `${this.c.nombre || ''}`;
    for (let i = 1; i <= n; i++) {
      p.enPagina(i);
      const y = this.H - 52;
      p.rect(this.M, y, this.CW, 26, { fill: '#d1d5db', r: 8, abajo: true });
      p.texto(this.c.nombre || '', this.M + 14, y + 16.5, { size: 8, bold: true, color: '#111827', max: this.CW / 2 });
      const der = `Página ${i} de ${n}`;
      p.texto(der, this.M + this.CW - 14, y + 16.5, { size: 8, color: '#111827', align: 'right' });
      const wd = p.ancho(der, 8) + 18, wf = p.ancho(f, 8, true);
      p.texto(f, this.M + this.CW - 14 - wd, y + 16.5, { size: 8, bold: true, color: '#111827', align: 'right' });
      p.texto('Fecha de descarga: ', this.M + this.CW - 14 - wd - wf, y + 16.5, { size: 8, color: '#111827', align: 'right' });
    }
    void marca;
    await guardarBlob(await p.blob(), nombre);
  }
}

const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
export const textoPeriodo = (desde, hasta) => `${dmy(desde)} - ${dmy(hasta)}`;
const nombrePeriodo = (anio, mes) => mes ? `${MESES[mes - 1].toLowerCase()}-${anio}` : `${anio}`;

// Detalle agrupado tipo «grupo → clasificación → concepto» con subtotales
function detalleAgrupado(R, grupos, { totalTexto, conceptoDe = x => x.concepto } = {}) {
  const filas = [];
  for (const g of grupos.filter(x => x.total)) {
    filas.push({ celdas: [g.nombre, dinero(g.total)], estilo: 'grupo' });
    for (const c of g.clasificaciones) {
      filas.push({ celdas: [c.nombre, dinero(c.total)], estilo: 'clasif' });
      for (const x of c.conceptos) filas.push({ celdas: [conceptoDe(x), dinero(x.total)], estilo: 'detalle' });
      filas.push({ celdas: [`Total ${c.nombre}`, dinero(c.total)], estilo: 'subtotal', alinear0: 'right' });
    }
    filas.push({ celdas: [`Total ${g.nombre.toLowerCase()}`, dinero(g.total)], estilo: 'total', alinear0: 'right' });
  }
  filas.push({ celdas: [totalTexto, dinero(grupos.reduce((a, g) => a + g.total, 0))], estilo: 'banda', alinear0: 'right', ultima: true });
  R.tabla([{ t: 'Concepto', wrap: true }, { t: 'Importe', w: 110, align: 'right', monto: true }], filas);
}

function tablaDesglose(R, titulo, filas, total, { col = 'Concepto', n = 'Movimientos' } = {}) {
  if (!filas.length) return;
  R.seccion(titulo);
  R.tabla([{ t: col, wrap: true }, { t: n, w: 80, align: 'center' }, { t: '% del total', w: 80, align: 'right' }, { t: 'Importe', w: 110, align: 'right' }],
    [...filas.map(([k, cnt, v]) => [k, String(cnt), total ? `${(v / total * 100).toFixed(1)}%` : '—', dinero(v)]), { celdas: ['Total', String(filas.reduce((a, f) => a + f[1], 0)), '100%', dinero(total)], estilo: 'banda', ultima: true }], { size: 8.5 });
}

// ---------- Reporte de ingresos ----------
export async function pdfIngresos(d, condominio) {
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Reporte de ingresos', periodo: textoPeriodo(d.desde, d.hasta), color: COLORES.ingresos });
  const COL = { pendientes: '#c8c8c8', ordinarios: '#a9d3ec', extraordinarios: '#1279a8', otros: '#f6b951' };
  const grupos = d.grupos.filter(g => g.total);
  const varPct = (x, y) => y ? `${x >= y ? '+' : ''}${((x - y) / Math.abs(y) * 100).toFixed(1)}%` : '—';
  R.kpis([{ label: 'Total de ingresos', valor: dinero(d.total) }, { label: 'Periodo anterior', valor: dinero(d.anterior?.total || 0) }, { label: 'Variación', valor: varPct(d.total, d.anterior?.total), tinta: d.anterior && d.total < d.anterior.total ? ROJO : VERDE }, { label: 'Pagos recibidos', valor: String(d.pagos) }]);
  R.dona(grupos.map(g => ({ label: g.clave === 'pendientes' ? `${g.nombre}*` : g.nombre, valor: g.total, color: COL[g.clave] })), { centro: 'Total de ingresos' });
  R.tabla([{ t: 'Ingresos' }, { t: 'Monto', w: 140, align: 'right' }], [...grupos.map(g => ({ celdas: [g.clave === 'pendientes' ? `${g.nombre}*` : g.nombre, dinero(g.total)], swatch: COL[g.clave] })),
    { celdas: ['Total de ingresos', dinero(d.total)], estilo: 'banda', ultima: true }], { size: 9.5 });
  if (grupos.some(g => g.clave === 'pendientes')) R.parrafo('* Pagos recibidos durante el periodo que aún no cubren ninguna cuota: quedan como saldo a favor de la unidad y se aplican a sus siguientes cuotas.', { size: 8.5, color: SUAVE, align: 'center' });
  // por clasificación
  const clas = grupos.flatMap(g => g.clasificaciones.map(c => ({ label: g.clave === 'pendientes' ? 'Ingresos pendientes de aplicar*' : c.nombre, valor: c.total })));
  R.nueva(); R.seccion('Ingresos por clasificación');
  R.barrasH(clas);
  R.tabla([{ t: 'Ingresos por clasificación', wrap: true }, { t: 'Monto', w: 130, align: 'right' }], [...clas.map((c, i) => ({ celdas: [c.label, dinero(c.valor)], swatch: PALETA[i % PALETA.length] })),
    { celdas: ['Total de ingresos', dinero(d.total)], estilo: 'banda', ultima: true }]);
  // mes con mes
  if (d.mensual?.length) {
    R.seccion(`Ingresos mes con mes · ${d.anio}`, 'Lo cobrado en cada mes del año, clasificado por lo que pagó.');
    const ms = d.mensual;
    R.barrasV(ms.map(x => MES3[+x.periodo.slice(5) - 1]), [{ nombre: 'Ordinarios', valores: ms.map(x => x.ordinarios || 0), color: '#1b6fb5' }, { nombre: 'Extraordinarios', valores: ms.map(x => x.extraordinarios || 0), color: '#f28c38' },
      { nombre: 'Pendientes de aplicar', valores: ms.map(x => x.pendientes || 0), color: '#bfc5cc' }, { nombre: 'Otros', valores: ms.map(x => x.otros || 0), color: '#5bbf63' }]);
    const t = k => ms.reduce((a, x) => a + (x[k] || 0), 0);
    R.tabla([{ t: 'Mes' }, { t: 'Ordinarios', w: 88, align: 'right' }, { t: 'Extraordinarios', w: 88, align: 'right' }, { t: 'Pend. aplicar', w: 80, align: 'right' }, { t: 'Otros', w: 70, align: 'right' }, { t: 'Total', w: 92, align: 'right' }],
      [...ms.map(x => [MESES[+x.periodo.slice(5) - 1], dinero(x.ordinarios || 0), dinero(x.extraordinarios || 0), dinero(x.pendientes || 0), dinero(x.otros || 0), dinero(x.total)]),
        { celdas: ['Total del año', dinero(t('ordinarios')), dinero(t('extraordinarios')), dinero(t('pendientes')), dinero(t('otros')), dinero(t('total'))], estilo: 'banda', ultima: true }], { size: 8 });
  }
  R.nueva();
  tablaDesglose(R, 'Por forma de pago', (d.por_metodo || []).map(x => [x.metodo, x.n, x.monto]), d.cobrado, { col: 'Forma de pago', n: 'Pagos' });
  tablaDesglose(R, 'Por cuenta de depósito', (d.por_cuenta || []).map(x => [x.cuenta, x.n, x.monto]), d.cobrado, { col: 'Cuenta', n: 'Pagos' });
  if (d.cancelados?.n) R.parrafo(`En el periodo se cancelaron ${d.cancelados.n} recibos por ${dinero(d.cancelados.monto)}; su importe ya está descontado del total.`, { size: 8.5, color: SUAVE });
  if (d.recibos?.length) {
    R.seccion('Relación de recibos', 'Cada cobro del periodo, en el orden en que se registró.');
    R.tabla([{ t: 'Recibo', w: 50 }, { t: 'Fecha', w: 58 }, { t: 'Unidad', w: 46 }, { t: 'Propietario', wrap: true }, { t: 'Forma de pago', w: 76 }, { t: 'Referencia', w: 82 }, { t: 'Importe', w: 72, align: 'right' }],
      [...d.recibos.map(r => ({ celdas: [`R-${r.folio}`, dmy(r.fecha), r.clave, r.propietario || '—', r.metodo, r.referencia || '', dinero(r.monto)], tintas: r.cancelado ? { 6: ROJO } : undefined })),
        { celdas: ['Total', '', '', '', '', '', dinero(d.cobrado)], estilo: 'banda', ultima: true }], { size: 7.5 });
  }
  R.nueva(); R.seccion('Detalle de ingresos', 'Cada clasificación con los conceptos que se cobraron en el periodo.');
  detalleAgrupado(R, d.grupos, { totalTexto: 'Total de ingresos' });
  await R.guardar(`reporte-ingresos-${slug(condominio.nombre)}-${nombrePeriodo(d.anio, d.mes)}.pdf`);
}

// ---------- Reporte de egresos ----------
export async function pdfEgresos(d, condominio) {
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Reporte de egresos', periodo: textoPeriodo(d.desde, d.hasta), color: COLORES.egresos });
  const grupos = d.grupos.filter(g => g.total);
  const COL = { ordinarios: '#fb8f4a', extraordinarios: '#ffbb55' };
  const varPct = (x, y) => y ? `${x >= y ? '+' : ''}${((x - y) / Math.abs(y) * 100).toFixed(1)}%` : '—';
  R.kpis([{ label: 'Total de egresos', valor: dinero(d.total) }, { label: 'Periodo anterior', valor: dinero(d.anterior?.total || 0) }, { label: 'Pagado', valor: dinero(d.pagado) }, { label: d.presupuesto ? 'Ejercido del presupuesto' : 'Por pagar', valor: d.presupuesto ? (d.presupuesto.total ? `${(d.presupuesto.ejercido / d.presupuesto.total * 100).toFixed(0)}%` : '—') : dinero(d.por_pagar), tinta: d.presupuesto && d.presupuesto.ejercido > d.presupuesto.total ? ROJO : undefined }]);
  R.dona(grupos.map(g => ({ label: g.nombre, valor: g.total, color: COL[g.clave] })), { centro: 'Total de egresos' });
  R.tabla([{ t: 'Egresos' }, { t: 'Monto', w: 140, align: 'right' }], [...grupos.map(g => ({ celdas: [g.nombre, dinero(g.total)], swatch: COL[g.clave] })),
    { celdas: ['Total de egresos', dinero(d.total)], estilo: 'banda', ultima: true }], { size: 9.5 });
  R.parrafo('Ordinarios: gasto de operación con cargo a las cuotas de mantenimiento. Extraordinarios: con cargo al fondo de reserva o a fondos específicos.', { size: 8.5, color: SUAVE, align: 'center' });
  const clas = grupos.flatMap(g => g.clasificaciones.map(c => ({ label: c.nombre, valor: c.total })));
  R.nueva(); R.seccion('Egresos por clasificación presupuestal');
  R.barrasH(clas);
  R.tabla([{ t: 'Egresos por clasificación', wrap: true }, { t: 'Monto', w: 130, align: 'right' }], [...clas.map((c, i) => ({ celdas: [c.label, dinero(c.valor)], swatch: PALETA[i % PALETA.length] })),
    { celdas: ['Total de egresos', dinero(d.total)], estilo: 'banda', ultima: true }]);
  if (d.mensual?.length) {
    const ms = d.mensual;
    R.seccion(`Egresos mes con mes · ${d.anio}`, 'Gasto aprobado de cada mes contra el presupuesto.');
    R.barrasV(ms.map(x => MES3[+x.periodo.slice(5) - 1]), [{ nombre: 'Ordinarios', valores: ms.map(x => x.ordinarios || 0), color: '#fb8f4a' }, { nombre: 'Extraordinarios', valores: ms.map(x => x.extraordinarios || 0), color: '#ffbb55' }, { nombre: 'Presupuesto', valores: ms.map(x => x.presupuesto || 0), color: '#bfc5cc' }]);
    const t = k => ms.reduce((a, x) => a + (x[k] || 0), 0);
    R.tabla([{ t: 'Mes' }, { t: 'Ordinarios', w: 95, align: 'right' }, { t: 'Extraordinarios', w: 95, align: 'right' }, { t: 'Total', w: 95, align: 'right' }, { t: 'Presupuesto', w: 95, align: 'right' }],
      [...ms.map(x => [MESES[+x.periodo.slice(5) - 1], dinero(x.ordinarios || 0), dinero(x.extraordinarios || 0), dinero(x.total), dinero(x.presupuesto || 0)]),
        { celdas: ['Total del año', dinero(t('ordinarios')), dinero(t('extraordinarios')), dinero(t('total')), dinero(t('presupuesto'))], estilo: 'banda', ultima: true }], { size: 8 });
  }
  R.nueva();
  const partidas = grupos.find(g => g.clave === 'ordinarios')?.clasificaciones || [];
  if (d.presupuesto) {
    R.seccion('Gasto ordinario contra presupuesto', `Presupuesto ${d.presupuesto.aprobado ? 'aprobado' : 'en borrador'} del periodo, por partida. El gasto de fondos (reserva y proyectos) no consume presupuesto.`);
    const filas = [...partidas.map(c => ({ n: c.nombre, e: c.total, p: c.presupuesto || 0 })), ...(d.presupuesto.sin_gasto || []).map(x => ({ n: x.nombre, e: 0, p: x.presupuesto }))].sort((a, b) => a.n.localeCompare(b.n));
    R.tabla([{ t: 'Partida', wrap: true }, { t: 'Presupuesto', w: 88, align: 'right' }, { t: 'Ejercido', w: 88, align: 'right' }, { t: 'Diferencia', w: 88, align: 'right' }, { t: '% ejercido', w: 64, align: 'right' }],
      [...filas.map(f => ({ celdas: [f.n, dinero(f.p), dinero(f.e), dinero(f.p - f.e), f.p ? `${(f.e / f.p * 100).toFixed(0)}%` : '—'], tintas: f.e > f.p && f.p ? { 3: ROJO, 4: ROJO } : undefined })),
        { celdas: ['Total', dinero(d.presupuesto.total), dinero(d.presupuesto.ejercido), dinero(d.presupuesto.total - d.presupuesto.ejercido), d.presupuesto.total ? `${(d.presupuesto.ejercido / d.presupuesto.total * 100).toFixed(0)}%` : '—'], estilo: 'banda', ultima: true }], { size: 8 });
  }
  tablaDesglose(R, 'Por proveedor', (d.por_proveedor || []).map(x => [x.proveedor, x.n, x.monto]), d.total, { col: 'Proveedor', n: 'Documentos' });
  tablaDesglose(R, 'Pagos por cuenta de salida', (d.por_cuenta || []).map(x => [x.cuenta, x.n, x.monto]), d.pagado, { col: 'Cuenta', n: 'Pagos' });
  R.nueva(); R.seccion('Detalle de egresos', 'Cada clasificación con los gastos del periodo (folio, fecha y proveedor).');
  detalleAgrupado(R, d.grupos, { totalTexto: 'Total de egresos', conceptoDe: x => `${x.concepto}${x.proveedor ? ` · ${x.proveedor}` : ''} · E-${x.folio} · ${dmy(x.fecha)}${x.estado === 'aprobado' ? ' · por pagar' : ''}` });
  await R.guardar(`reporte-egresos-${slug(condominio.nombre)}-${nombrePeriodo(d.anio, d.mes)}.pdf`);
}

// ---------- Saldos de bancos y cajas ----------
export async function pdfBancos(d, condominio) {
  const periodo = d.desde === d.hasta ? mesNombre(d.hasta) : `${mesNombre(d.desde)} a ${mesNombre(d.hasta)}`;
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Saldo de bancos y cajas', periodo, color: COLORES.bancos });
  const T = d.totales;
  R.kpis([{ label: 'Saldo anterior', valor: dinero(T.anterior) }, { label: 'Ingresos', valor: dinero(T.ingresos), color: '#3cc13b' }, { label: 'Egresos', valor: dinero(T.egresos), color: COLORES.egresos }, { label: 'Saldo final', valor: dinero(T.final) }]);
  const verde = '#3cc13b', azul = '#2563eb';
  const g = 14, w = (R.CW - g) / 2, h = 214;
  d.cuentas.forEach((c, i) => {
    if (i % 2 === 0 && R.necesita(h + 14)) { /* nueva página */ }
    const x = R.M + (i % 2) * (w + g), y = R.y, p = R.pdf;
    p.rect(x, y, w, h, { stroke: verde, lw: 0.9, r: 7 });
    p.texto(`${c.banco} - ${c.nombre}`, x + w / 2, y + 24, { size: 12, bold: true, color: azul, align: 'center', max: w - 20 });
    const filas = [['Código:', c.codigo + (c.numero_mask ? ` · ${c.numero_mask}` : ''), azul], ['Saldo anterior:', dinero(c.anterior)], ['Ingresos:', dinero(c.ingresos)], ['Egresos:', dinero(c.egresos)], ['Saldo final:', dinero(c.final), null, true]];
    filas.forEach(([k, v, col, b], j) => {
      p.texto(k, x + 14, y + 46 + j * 17, { size: 9.5, bold: true, color: col || TINTA });
      p.texto(v, x + w - 14, y + 46 + j * 17, { size: 9.5, bold: !!b, color: col || TINTA, align: 'right' });
    });
    R.lineaEn(x + 6, y + 128, w - 14, 78, c.serie.map(s => MESES[+s.periodo.slice(5) - 1].slice(0, 3)), c.serie.map(s => s.saldo), { color: verde });
    if (i % 2 === 1 || i === d.cuentas.length - 1) R.y += h + 14;
  });
  R.banda(`Saldo total: ${dinero(T.final)}`);
  R.seccion('Tendencia del saldo total', 'Suma de todas las cuentas al cierre de cada mes.');
  R.necesita(150); const t = R.tarjeta(140);
  R.lineaEn(t.x + 10, t.y + 12, t.w - 20, 118, d.serie.map(s => MES3[+s.periodo.slice(5) - 1]), d.serie.map(s => s.saldo), { color: azul });
  R.parrafo(`Información actualizada hasta el ${dmy(hoyISO())}. Saldos según los registros contables del condominio.`, { size: 9, align: 'center' });
  await R.guardar(`saldos-bancarios-${slug(condominio.nombre)}-${d.hasta}.pdf`);
}

// ---------- Conciliación bancaria ----------
export async function pdfConciliacion(d, condominio) {
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Conciliación bancaria', periodo: `Al ${dmy(d.corte)}`, color: COLORES.conciliacion });
  const con = d.cuentas.filter(c => !c.sin_estado);
  R.kpis([{ label: 'Cuentas conciliadas', valor: `${con.filter(c => !c.diferencia).length} de ${d.cuentas.length}` }, { label: 'Movimientos del periodo', valor: String(con.reduce((a, c) => a + c.periodo.movimientos, 0)) },
    { label: 'Conciliados', valor: pct(con.reduce((a, c) => a + c.periodo.conciliados, 0), con.reduce((a, c) => a + c.periodo.movimientos, 0), 0) }, { label: 'Diferencia total', valor: dinero(con.reduce((a, c) => a + c.diferencia, 0)), tinta: con.some(c => c.diferencia) ? ROJO : VERDE }]);
  if (con.length) {
    R.seccion('Avance de conciliación del periodo', 'Movimientos del estado de cuenta que ya están identificados con un pago o un egreso.');
    R.barrasH(con.map(c => ({ label: `${c.banco} ${c.nombre}`, valor: c.periodo.movimientos ? Math.round(c.periodo.conciliados / c.periodo.movimientos * 10000) : 0, color: COLORES.conciliacion })), { formato: v => `${(v / 100).toFixed(0)}%` });
  }
  for (const c of d.cuentas) {
    R.seccion(`${c.banco} · ${c.nombre}${c.numero_mask ? ` · ${c.numero_mask}` : ''}`, c.sin_estado ? 'Sin estado de cuenta importado: importe el CSV del banco en Bancos y conciliación.' : `Estado de cuenta importado desde el ${dmy(c.desde_estado)}; último movimiento ${dmy(c.ultimo_mov)}.`);
    if (c.sin_estado) { R.tabla([{ t: 'Concepto' }, { t: 'Importe', w: 130, align: 'right' }], [['Saldo en libros', dinero(c.libros)]]); continue; }
    R.tabla([{ t: 'Concepto' }, { t: 'Importe', w: 130, align: 'right' }], [
      [`Saldo según estado de cuenta al ${dmy(d.corte)}`, dinero(c.saldo_banco)],
      ['(−) Depósitos en el banco no registrados en libros', dinero(-c.abonos_no_registrados)],
      ['(+) Retiros en el banco no registrados en libros', dinero(c.cargos_no_registrados)],
      ['(+) Depósitos registrados aún no reflejados en el banco', dinero(c.depositos_transito)],
      ['(−) Pagos registrados aún no reflejados en el banco', dinero(-c.pagos_transito)],
      ...(c.otros_libros ? [['(±) Otros asientos en libros (traspasos, cancelaciones, ajustes)', dinero(c.otros_libros)]] : []),
      { celdas: ['Saldo conciliado', dinero(c.saldo_conciliado)], estilo: 'total' },
      ['Saldo en libros', dinero(c.libros)],
      { celdas: ['Diferencia por aclarar', dinero(c.diferencia)], estilo: 'banda', ultima: true },
    ], { size: 9 });
    const lista = (t, rows, fn) => { if (!rows.length) return; R.necesita(60); R.pdf.texto(t, R.M, R.y + 10, { size: 9.5, bold: true, color: '#111827' }); R.y += 16; R.tabla([{ t: 'Fecha', w: 66 }, { t: 'Descripción', wrap: true }, { t: 'Importe', w: 100, align: 'right' }], rows.slice(0, 60).map(fn), { size: 8 }); };
    lista('Movimientos del banco sin identificar', c.no_registrados, m => [dmy(m.fecha), `${m.descripcion || ''}${m.referencia ? ` · ${m.referencia}` : ''}`, dinero(m.abono_cents || -m.cargo_cents)]);
    lista('Depósitos en tránsito (en libros, no en el banco)', c.depositos_en_transito, m => [dmy(m.fecha), `${m.documento}${m.referencia ? ` · ${m.referencia}` : ''}`, dinero(m.monto)]);
    lista('Pagos en tránsito (en libros, no en el banco)', c.pagos_en_transito, m => [dmy(m.fecha), m.documento, dinero(-m.monto)]);
  }
  R.parrafo('El saldo del banco se calcula con el saldo en libros al día anterior al primer movimiento importado más los movimientos del estado de cuenta.', { size: 8, color: SUAVE });
  await R.guardar(`conciliacion-bancaria-${slug(condominio.nombre)}-${d.corte}.pdf`);
}

const BANDAS = [['por_vencer', 'Por vencer', '#9fcbe9'], ['d30', '1 a 30 días', '#f6b951'], ['d60', '31 a 60 días', '#f28c38'], ['d90', '61 a 90 días', '#e8596b'], ['d90mas', 'Más de 90 días', '#b42318']];

// ---------- Cuentas por cobrar ----------
export async function pdfCxc(d, condominio) {
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Cuentas por cobrar', periodo: `Al ${dmy(d.corte)}`, color: COLORES.cxc });
  const rows = d.unidades.filter(u => u.adeudo > 0).sort((a, b) => a.clave.localeCompare(b.clave, 'es', { numeric: true }));
  const r = d.resumen, adeudo = rows.reduce((a, u) => a + u.adeudo, 0);
  R.kpis([{ label: 'Total por cobrar', valor: dinero(adeudo) }, { label: 'Vencido', valor: dinero(r.vencido), tinta: r.vencido ? ROJO : undefined }, { label: 'Por vencer', valor: dinero(r.por_vencer) }, { label: 'Unidades con adeudo', valor: `${rows.length} de ${r.unidades}` }]);
  R.dona(BANDAS.map(([k, l, c]) => ({ label: l, valor: r[k], color: c })), { centro: 'Por cobrar' });
  R.seccion('Cartera por unidad', 'Antigüedad de cada saldo desde su fecha de vencimiento.');
  const t = k => rows.reduce((a, u) => a + u[k], 0);
  R.tabla([{ t: 'Unidad', w: 52 }, { t: 'Propietario', wrap: true }, { t: 'Por vencer', w: 64, align: 'right' }, { t: '1–30', w: 60, align: 'right' }, { t: '31–60', w: 60, align: 'right' }, { t: '61–90', w: 60, align: 'right' }, { t: '+90', w: 60, align: 'right' }, { t: 'Total', w: 68, align: 'right' }],
    [...rows.map(u => ({ celdas: [u.clave, u.propietario || '—', dinero(u.por_vencer), dinero(u.d30), dinero(u.d60), dinero(u.d90), dinero(u.d90mas), dinero(u.adeudo)], tintas: { 6: u.d90mas ? ROJO : undefined } })),
      { celdas: ['Total', '', dinero(t('por_vencer')), dinero(t('d30')), dinero(t('d60')), dinero(t('d90')), dinero(t('d90mas')), dinero(adeudo)], estilo: 'banda', ultima: true }], { size: 7.5 });
  if (r.saldo_favor) R.parrafo(`Además, las unidades tienen saldos a favor por ${dinero(r.saldo_favor)} que se aplicarán a sus siguientes cuotas.`, { size: 8.5, color: SUAVE });
  await R.guardar(`cuentas-por-cobrar-${slug(condominio.nombre)}-${d.corte}.pdf`);
}

// ---------- Morosidad ----------
export async function pdfMorosidad(d, condominio) {
  const R = new Informe({ logo: await cargarLogo(condominio), condominio, titulo: 'Reporte de morosidad', periodo: `Al ${dmy(d.corte)}`, color: COLORES.morosidad });
  const r = d.resumen, rows = d.unidades.filter(u => u.activo && u.vencido > 0).sort((a, b) => b.vencido - a.vencido);
  R.kpis([{ label: 'Morosidad', valor: `${(r.pct_morosidad * 100).toFixed(1)}%` }, { label: 'Unidades morosas', valor: `${r.morosas} de ${r.unidades}` }, { label: 'Cartera vencida', valor: dinero(r.vencido), tinta: r.vencido ? ROJO : undefined }, { label: 'Más de 90 días', valor: dinero(r.d90mas), tinta: r.d90mas ? ROJO : undefined }]);
  R.seccion('Antigüedad de la cartera vencida');
  R.barrasH(BANDAS.slice(1).map(([k, l, c]) => ({ label: l, valor: r[k], color: c })), { etiqueta: 110 });
  if (rows.length) { R.seccion('Unidades con mayor adeudo vencido'); R.barrasH(rows.slice(0, 12).map(u => ({ label: `${u.clave} · ${u.propietario || ''}`, valor: u.vencido, color: COLORES.morosidad }))); }
  if (d.tendencia?.length) {
    R.seccion('Tendencia de la cartera vencida', 'Saldo vencido al cierre de cada mes.');
    R.barrasV(d.tendencia.map(t => MES3[+t.periodo.slice(5) - 1]), [{ nombre: 'Cartera vencida', valores: d.tendencia.map(t => t.vencido), color: COLORES.morosidad }], { alto: 180 });
  }
  R.seccion(`Unidades morosas (${rows.length})`);
  R.tabla([{ t: 'Unidad', w: 50 }, { t: 'Propietario', wrap: true }, { t: 'Cuotas vencidas', w: 62, align: 'center' }, { t: 'Días de atraso', w: 58, align: 'center' }, { t: 'Recargos', w: 66, align: 'right' }, { t: 'Vencido', w: 74, align: 'right' }, { t: 'Último pago', w: 64, align: 'center' }],
    [...rows.map(u => ({ celdas: [u.clave, `${u.propietario || '—'}${u.convenio ? ' · convenio' : ''}`, String(u.meses), String(u.dias_max), dinero(u.recargos), dinero(u.vencido), u.ultimo_pago ? dmy(u.ultimo_pago) : '—'], tintas: { 5: ROJO } })),
      { celdas: ['Total', '', String(rows.reduce((a, u) => a + u.meses, 0)), '', dinero(rows.reduce((a, u) => a + u.recargos, 0)), dinero(r.vencido), ''], estilo: 'banda', ultima: true }], { size: 7.5 });
  if (d.cargos?.length) {
    const mor = new Set(rows.map(u => u.id));
    R.nueva(); R.seccion('Detalle de cargos vencidos', 'Cada cuota, recargo o cargo vencido de las unidades morosas.');
    R.tabla([{ t: 'Unidad', w: 50 }, { t: 'Concepto', wrap: true }, { t: 'Vencimiento', w: 66, align: 'center' }, { t: 'Días', w: 40, align: 'center' }, { t: 'Saldo', w: 80, align: 'right' }],
      [...d.cargos.filter(c => c.dias > 0 && mor.has(c.unidad_id)).map(c => [c.clave, c.concepto, dmy(c.vencimiento), String(c.dias), dinero(c.saldo_cents)]),
        { celdas: ['Total', '', '', '', dinero(r.vencido)], estilo: 'banda', ultima: true }], { size: 7.5 });
  }
  await R.guardar(`morosidad-${slug(condominio.nombre)}-${d.corte}.pdf`);
}

// ---------- Estado de cuenta ----------
const TIPO = { cuota: 'Cuota', extraordinaria: 'Extraordinaria', recargo: 'Recargo', multa: 'Multa', otro: 'Cargo', pago: 'Pago', descuento: 'Descuento', cancelacion: 'Cancelación', cancelacion_pago: 'Pago cancelado', saldo_inicial: 'Saldo inicial', cargo: 'Cargo', abono: 'Abono' };
const ESTATUS = { condonada: 'Condonada', pagada: 'Pagada', parcial: 'Pago parcial', pendiente: 'No pagada', cancelada: 'Cancelada', aplicado: 'Aplicado', cancelado: 'Cancelado' };
const COLOR_EST = { condonada: SUAVE, pagada: '#2563eb', parcial: '#2563eb', pendiente: ROJO, aplicado: VERDE, cancelada: SUAVE, cancelado: SUAVE };
const saldoTxt = s => s < 0 ? `+ ${dinero(-s)}` : dinero(s);

function cuerpoEstadoCuenta(R, d) {
  const prop = d.personas?.filter(p => p.rol === 'propietario').map(p => p.nombre).join(', ') || d.propietario || '—';
  const email = d.personas?.find(p => p.email)?.email;
  R.datos([['Propietario', prop], ['Unidad', `${d.unidad.clave}${d.unidad.torre ? ` · ${d.unidad.torre}` : ''}`], ['Referencia de pago', d.unidad.referencia], [d.saldo_final > 0 ? 'Saldo pendiente' : d.saldo_final < 0 ? 'Saldo a favor' : 'Saldo', d.saldo_final < 0 ? dinero(-d.saldo_final) : dinero(d.saldo_final), { size: 13, color: d.saldo_final > 0 ? ROJO : VERDE }],
    ...(email ? [['Correo', email]] : []), ['Periodo', textoPeriodo(d.desde, d.hasta)]], { columnas: 2 });
  const filas = [{ celdas: [dmy(d.desde), '', 'Saldo inicial', '', '', saldoTxt(d.saldo_inicial), ''], bold: true },
    ...d.movimientos.map(m => ({ celdas: [dmy(m.fecha), TIPO[m.tipo] || m.tipo, `${m.concepto || ''}${m.recibo ? ` · Recibo R-${m.recibo}` : ''}`, m.cargo ? dinero(m.cargo) : '–', m.abono ? dinero(m.abono) : '–', saldoTxt(m.saldo),
      m.estatus ? `${ESTATUS[m.estatus] || m.estatus}${m.estatus === 'parcial' ? ` (${dinero(m.saldo_cargo)})` : ''}` : ''], tintas: { 5: m.saldo < 0 ? VERDE : undefined, 6: COLOR_EST[m.estatus] } }))];
  R.tabla([{ t: 'Fecha', w: 58 }, { t: 'Tipo', w: 62 }, { t: 'Concepto', wrap: true }, { t: 'Cargo', w: 64, align: 'right' }, { t: 'Abono', w: 64, align: 'right' }, { t: 'Saldo', w: 68, align: 'right' }, { t: 'Estatus', w: 72 }], filas, { size: 7.5 });
  const T = d.totales || {};
  R.tabla([{ t: '' }, { t: '', w: 120, align: 'right' }], [
    { celdas: ['Total cuotas', dinero(T.cuotas || 0)], alinear0: 'right', bold: true, zebra: false },
    { celdas: ['Total penalidades (recargos y multas)', dinero(T.penalidades || 0)], alinear0: 'right', bold: true, zebra: false },
    { celdas: ['Total pagos', dinero(T.pagos || 0)], alinear0: 'right', bold: true, zebra: false },
    { celdas: ['Total descuentos y bonificaciones', dinero(T.descuentos || 0)], alinear0: 'right', bold: true, zebra: false },
    { celdas: [d.saldo_final < 0 ? 'Saldo a favor' : 'Saldo pendiente', dinero(Math.abs(d.saldo_final))], estilo: 'banda', alinear0: 'right', ultima: true },
  ], { encabezado: false, size: 9 });
  if (d.pendientes?.length) {
    R.seccion('Cuotas pendientes de pago');
    R.tabla([{ t: 'Concepto', wrap: true }, { t: 'Vencimiento', w: 80, align: 'center' }, { t: 'Saldo', w: 100, align: 'right' }], [...d.pendientes.map(p => [p.concepto, dmy(p.vencimiento), dinero(p.saldo_cents)]),
      { celdas: ['Total', '', dinero(d.pendientes.reduce((a, p) => a + p.saldo_cents, 0))], estilo: 'total' }], { size: 8 });
  }
  instruccionesPago(R, d.bancos, d.unidad.referencia);
}

function instruccionesPago(R, bancos, referencia) {
  R.necesita(70);
  R.seccion('Instrucciones de pago');
  if (bancos?.length) for (const b of bancos) R.parrafo(`• Transferencia o depósito a ${b.banco} · ${b.nombre}${b.clabe_mask ? ` · CLABE ${b.clabe_mask}` : ''}.`, { size: 9 });
  R.parrafo(`• Incluya en la referencia o concepto de la transferencia: ${referencia}. Así su pago se identifica automáticamente.`, { size: 9 });
}

export async function pdfEstadoCuenta(d) {
  const R = new Informe({ logo: await cargarLogo(d.condominio), condominio: d.condominio, titulo: 'Estado de cuenta', periodo: textoPeriodo(d.desde, d.hasta), color: COLORES.cuenta });
  cuerpoEstadoCuenta(R, d);
  await R.guardar(`estado-de-cuenta-${slug(d.unidad.clave)}-${d.hasta}.pdf`);
}
export async function pdfEstadosCuenta(all) {
  let R = null;
  for (const x of all.unidades) {
    const d = { ...x, condominio: all.condominio, bancos: all.bancos, desde: all.desde, hasta: all.hasta };
    if (!R) R = new Informe({ logo: await cargarLogo(all.condominio), condominio: all.condominio, titulo: `Estado de cuenta · ${x.unidad.clave}`, periodo: textoPeriodo(all.desde, all.hasta), color: COLORES.cuenta });
    else R.documento({ condominio: all.condominio, titulo: `Estado de cuenta · ${x.unidad.clave}`, periodo: textoPeriodo(all.desde, all.hasta), color: COLORES.cuenta });
    cuerpoEstadoCuenta(R, d);
  }
  if (R) await R.guardar(`estados-de-cuenta-${slug(all.condominio.nombre)}-${all.hasta}.pdf`);
}

// ---------- Recibos de pago (uno por página) ----------
const METODO = { transferencia: 'Transferencia', deposito: 'Depósito', efectivo: 'Efectivo', tarjeta: 'Tarjeta', cheque: 'Cheque', domiciliacion: 'Domiciliación' };
function cuerpoRecibo(R, r) {
  const p = r.pago;
  R.datos([['Unidad', p.clave], ['Recibimos de', r.propietario || '—'], ['Fecha de pago', dmy(p.fecha)], ['Forma de pago', `${METODO[p.metodo] || p.metodo}${p.banco ? ` · ${p.banco}` : ''}`],
    ['Referencia', p.referencia || '—'], ['Importe recibido', dinero(p.monto_cents), { size: 15, color: VERDE }]], { columnas: 2 });
  if (p.estado === 'cancelado') { R.pdf.texto('RECIBO CANCELADO', R.M + R.CW / 2, R.y + 6, { size: 16, bold: true, color: ROJO, align: 'center' }); R.y += 22; }
  R.seccion('Aplicación del pago');
  const ap = r.aplicaciones.filter(a => !a.revertida), sum = ap.reduce((a, x) => a + x.monto_cents, 0);
  R.tabla([{ t: 'Concepto', wrap: true }, { t: 'Importe', w: 120, align: 'right' }], [...ap.map(a => [a.concepto, dinero(a.monto_cents)]),
    ...(p.monto_cents - sum > 0 && p.estado !== 'cancelado' ? [['Saldo a favor (se aplica a las siguientes cuotas)', dinero(p.monto_cents - sum)]] : []),
    { celdas: ['Total', dinero(p.monto_cents)], estilo: 'banda', ultima: true }], { size: 9 });
  R.necesita(90); R.y += 34;
  R.pdf.linea(R.M + R.CW / 2 - 110, R.y, R.M + R.CW / 2 + 110, R.y, { color: TINTA, lw: 0.8 });
  R.pdf.texto('Administración', R.M + R.CW / 2, R.y + 13, { size: 9, align: 'center' }); R.y += 30;
  R.parrafo(`Sello de integridad: ${r.sello}`, { size: 7.5, color: SUAVE, align: 'center' });
}
export async function pdfRecibos(recibos, nombre) {
  if (!recibos.length) throw new Error('No hay recibos en el periodo.');
  let R = null;
  for (const r of recibos) {
    const o = { condominio: r.condominio, titulo: `Recibo de pago R-${r.pago.folio}`, periodo: dmy(r.pago.fecha), color: COLORES.cuenta, etiqueta: 'Fecha de pago: ' };
    if (!R) R = new Informe({ ...o, logo: await cargarLogo(o.condominio) }); else R.documento(o);
    cuerpoRecibo(R, r);
  }
  await R.guardar(nombre || (recibos.length === 1 ? `recibo-R-${recibos[0].pago.folio}.pdf` : `recibos-${slug(recibos[0].pago.clave)}.pdf`));
}

// ---------- Avisos de cobro (uno por unidad) ----------
function textoRecargo(c) {
  if (c.recargo_modo === 'fijo' && c.recargo_fijo_cents) return `Las cuotas vencidas generan un recargo de ${dinero(c.recargo_fijo_cents)} por cada cuota cada mes.`;
  if (!c.tasa_recargo_bp) return '';
  const t = (c.tasa_recargo_bp / 100).toFixed(2).replace(/\.00$/, '');
  return c.recargo_modo === 'cuota' ? `Las cuotas vencidas generan un recargo mensual del ${t}% sobre el importe de cada cuota.` : `El saldo vencido genera un recargo mensual del ${t}%.`;
}
function cuerpoAviso(R, x, c, bancos, fecha) {
  const pend = x.pendientes || [];
  const total = pend.reduce((a, p) => a + p.saldo_cents, 0), vencido = pend.filter(p => p.vencimiento < fecha).reduce((a, p) => a + p.saldo_cents, 0);
  const proximo = pend.find(p => p.vencimiento >= fecha)?.vencimiento;
  R.datos([['Propietario', x.propietario || '—'], ['Unidad', x.unidad.clave], ['Referencia de pago', x.unidad.referencia], ['Total a pagar', dinero(total), { size: 15, color: total ? ROJO : VERDE }],
    ['Saldo vencido', dinero(vencido), { color: vencido ? ROJO : undefined }], ['Pagar antes del', proximo ? dmy(proximo) : vencido ? 'Inmediato' : '—']], { columnas: 3 });
  R.parrafo(`Estimado(a) condómino(a): le informamos que al ${dmy(fecha)} la unidad ${x.unidad.clave} presenta los siguientes adeudos. Le agradecemos realizar su pago a la brevedad para mantener al corriente los servicios del condominio.`, { size: 9.5 });
  R.tabla([{ t: 'Concepto', wrap: true }, { t: 'Vencimiento', w: 78, align: 'center' }, { t: 'Estatus', w: 70, align: 'center' }, { t: 'Importe', w: 96, align: 'right' }],
    [...pend.map(p => ({ celdas: [p.concepto, dmy(p.vencimiento), p.vencimiento < fecha ? 'Vencido' : 'Por vencer', dinero(p.saldo_cents)], tintas: { 2: p.vencimiento < fecha ? ROJO : undefined } })),
      { celdas: ['Total a pagar', '', '', dinero(total)], estilo: 'banda', ultima: true }], { size: pend.length > 12 ? 7.5 : 8.5 });
  if (x.saldo_favor) R.parrafo(`La unidad tiene un saldo a favor de ${dinero(x.saldo_favor)} que se aplicará automáticamente.`, { size: 9, color: VERDE });
  const rec = textoRecargo(c);
  if (rec) R.parrafo(`${rec} Evítelos pagando antes de la fecha de vencimiento.`, { size: 9, color: SUAVE });
  if (c.pronto_pago_bp && c.pronto_pago_dia) R.parrafo(`Descuento por pronto pago: ${(c.pronto_pago_bp / 100).toFixed(2).replace(/\.00$/, '')}% en la cuota ordinaria del mes si paga completo a más tardar el día ${c.pronto_pago_dia}.`, { size: 9, color: VERDE });
  instruccionesPago(R, bancos, x.unidad.referencia);
  R.parrafo('Si ya realizó su pago, le agradecemos y le pedimos hacer caso omiso de este aviso.', { size: 8.5, color: SUAVE, align: 'center' });
}
export async function pdfAvisos(lista, { condominio, bancos, fecha = hoyISO(), nombre } = {}) {
  const con = lista.filter(x => (x.pendientes || []).length);
  if (!con.length) throw new Error('Ninguna unidad tiene adeudos pendientes.');
  let R = null;
  for (const x of con) {
    const o = { condominio, titulo: `Aviso de cobro · ${x.unidad.clave}`, periodo: dmy(fecha), color: COLORES.morosidad, etiqueta: 'Fecha de emisión: ' };
    if (!R) R = new Informe({ ...o, logo: await cargarLogo(o.condominio) }); else R.documento(o);
    cuerpoAviso(R, x, condominio, bancos, fecha);
  }
  await R.guardar(nombre || (con.length === 1 ? `aviso-de-cobro-${slug(con[0].unidad.clave)}-${fecha}.pdf` : `avisos-de-cobro-${slug(condominio.nombre)}-${fecha}.pdf`));
}
