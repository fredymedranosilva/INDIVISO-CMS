// Generador de PDF mínimo, sin dependencias: Helvetica (codificación WinAnsi, con acentos y ñ),
// rectángulos, líneas, curvas, sectores de dona y transparencia. Coordenadas con origen arriba a la izquierda, en puntos.

// Anchos de Helvetica y Helvetica-Bold (AFM) para ASCII 32–126.
const ASCII_R = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const ASCII_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// Unicode → byte WinAnsi para lo que no coincide con Latin-1.
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '−': 0x2d, ' ': 0x20, ' ': 0x20, ' ': 0x20 };
const EXTRA_W = { 0x80: [556, 556], 0x85: [1000, 1000], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x82: [222, 278], 0x84: [333, 500],
  0xa1: [333, 333], 0xa2: [556, 556], 0xa3: [556, 556], 0xa5: [556, 556], 0xa7: [556, 556], 0xa9: [737, 737], 0xaa: [370, 370], 0xab: [556, 556], 0xae: [737, 737], 0xb0: [400, 400], 0xb1: [584, 584], 0xb2: [333, 333], 0xb3: [333, 333],
  0xb5: [556, 611], 0xb7: [278, 278], 0xba: [365, 365], 0xbb: [556, 556], 0xbf: [611, 611], 0xc6: [1000, 1000], 0xd7: [584, 584], 0xdf: [611, 611], 0xe6: [889, 889], 0xf7: [584, 584] };

function byteDe(ch) {
  if (WIN[ch] != null) return WIN[ch];
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  const base = ch.normalize('NFD')[0];
  return base && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126 ? base.charCodeAt(0) : 0x3f;
}
function anchoByte(b, bold) {
  if (b >= 32 && b <= 126) return (bold ? ASCII_B : ASCII_R)[b - 32];
  if (EXTRA_W[b]) return EXTRA_W[b][bold ? 1 : 0];
  if (b >= 0xc0) { // letras acentuadas: el ancho de su letra base
    const base = String.fromCharCode(b).normalize('NFD').charCodeAt(0);
    if (base >= 32 && base <= 126) return (bold ? ASCII_B : ASCII_R)[base - 32];
  }
  return 556;
}
const n2 = v => { const s = (Math.round(v * 100) / 100).toString(); return s === '-0' ? '0' : s; };
function rgb(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  return [0, 2, 4].map(i => n2(parseInt(f.slice(i, i + 2), 16) / 255)).join(' ');
}

export class PDF {
  constructor({ ancho = 612, alto = 792 } = {}) { this.W = ancho; this.H = alto; this.paginas = []; this.alfas = new Map(); }
  pagina() { this.ops = []; this.paginas.push(this.ops); return this.paginas.length; }
  enPagina(i) { this.ops = this.paginas[i - 1]; }
  get numPaginas() { return this.paginas.length; }
  _y(y) { return this.H - y; }
  _alfa(a) {
    if (a == null || a >= 1) return '';
    const k = n2(a); if (!this.alfas.has(k)) this.alfas.set(k, `GS${this.alfas.size + 1}`);
    return `/${this.alfas.get(k)} gs `;
  }
  _pintar({ fill, stroke, lw = 1, alfa, dash }) {
    let pre = 'q ' + this._alfa(alfa);
    if (fill) pre += `${rgb(fill)} rg `;
    if (stroke) pre += `${rgb(stroke)} RG ${n2(lw)} w `;
    if (dash) pre += `[${dash.join(' ')}] 0 d `;
    return { pre, op: fill && stroke ? 'B' : fill ? 'f' : 'S' };
  }
  rect(x, y, w, h, o = {}) {
    const { pre, op } = this._pintar(o);
    const r = Math.min(o.r || 0, w / 2, h / 2);
    if (!r) { this.ops.push(`${pre}${n2(x)} ${n2(this._y(y + h))} ${n2(w)} ${n2(h)} re ${op} Q`); return; }
    // esquinas redondeadas (r) o solo arriba (o.arriba) / solo abajo (o.abajo)
    const k = 0.5523 * r, X = x, Y = this._y(y), R = x + w, B = this._y(y + h);
    const rt = o.abajo ? 0 : r, rb = o.arriba ? 0 : r, kt = o.abajo ? 0 : k, kb = o.arriba ? 0 : k;
    const p = [`${n2(X + rt)} ${n2(Y)} m`, `${n2(R - rt)} ${n2(Y)} l`, `${n2(R - rt + kt)} ${n2(Y)} ${n2(R)} ${n2(Y - rt + kt)} ${n2(R)} ${n2(Y - rt)} c`,
      `${n2(R)} ${n2(B + rb)} l`, `${n2(R)} ${n2(B + rb - kb)} ${n2(R - rb + kb)} ${n2(B)} ${n2(R - rb)} ${n2(B)} c`, `${n2(X + rb)} ${n2(B)} l`,
      `${n2(X + rb - kb)} ${n2(B)} ${n2(X)} ${n2(B + rb - kb)} ${n2(X)} ${n2(B + rb)} c`, `${n2(X)} ${n2(Y - rt)} l`, `${n2(X)} ${n2(Y - rt + kt)} ${n2(X + rt - kt)} ${n2(Y)} ${n2(X + rt)} ${n2(Y)} c`];
    this.ops.push(`${pre}${p.join(' ')} h ${op} Q`);
  }
  linea(x1, y1, x2, y2, o = {}) { const { pre } = this._pintar({ stroke: o.color || '#000000', lw: o.lw ?? 0.5, dash: o.dash, alfa: o.alfa }); this.ops.push(`${pre}${n2(x1)} ${n2(this._y(y1))} m ${n2(x2)} ${n2(this._y(y2))} l S Q`); }
  // pts: [[x, y], ...]; curva suave opcional (Catmull-Rom a Bézier)
  trazo(pts, o = {}) {
    if (pts.length < 2) return;
    const { pre, op } = this._pintar(o.fill ? { fill: o.fill, alfa: o.alfa } : { stroke: o.color, lw: o.lw ?? 1.5, alfa: o.alfa });
    const P = pts.map(([x, y]) => [x, this._y(y)]);
    let d = `${n2(P[0][0])} ${n2(P[0][1])} m `;
    if (o.suave && P.length > 2) {
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `${n2(c1[0])} ${n2(c1[1])} ${n2(c2[0])} ${n2(c2[1])} ${n2(p2[0])} ${n2(p2[1])} c `;
      }
    } else for (const p of P.slice(1)) d += `${n2(p[0])} ${n2(p[1])} l `;
    if (o.cerrar) d += `${n2(o.cerrar[1][0])} ${n2(this._y(o.cerrar[1][1]))} l ${n2(o.cerrar[0][0])} ${n2(this._y(o.cerrar[0][1]))} l h `;
    this.ops.push(`${pre}${d}${op} Q`);
  }
  circulo(cx, cy, r, o = {}) {
    const { pre, op } = this._pintar(o), k = 0.5523 * r, X = cx, Y = this._y(cy);
    this.ops.push(`${pre}${n2(X + r)} ${n2(Y)} m ${n2(X + r)} ${n2(Y + k)} ${n2(X + k)} ${n2(Y + r)} ${n2(X)} ${n2(Y + r)} c ${n2(X - k)} ${n2(Y + r)} ${n2(X - r)} ${n2(Y + k)} ${n2(X - r)} ${n2(Y)} c `
      + `${n2(X - r)} ${n2(Y - k)} ${n2(X - k)} ${n2(Y - r)} ${n2(X)} ${n2(Y - r)} c ${n2(X + k)} ${n2(Y - r)} ${n2(X + r)} ${n2(Y - k)} ${n2(X + r)} ${n2(Y)} c h ${op} Q`);
  }
  // Sector de dona entre los ángulos a0 y a1 (radianes; 0 = arriba, sentido horario)
  sector(cx, cy, r0, r1, a0, a1, o = {}) {
    const { pre, op } = this._pintar(o);
    const pt = (r, a) => [cx + r * Math.sin(a), this._y(cy - r * Math.cos(a))];
    const arco = (r, from, to) => {
      let s = '';
      const n = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
      const step = (to - from) / n, k = 4 / 3 * Math.tan(step / 4);
      for (let i = 0; i < n; i++) {
        const a = from + i * step, b = a + step;
        const p1 = pt(r, a), p2 = pt(r, b);
        const c1 = [p1[0] + k * r * Math.cos(a), p1[1] - k * r * Math.sin(a)], c2 = [p2[0] - k * r * Math.cos(b), p2[1] + k * r * Math.sin(b)];
        s += `${n2(c1[0])} ${n2(c1[1])} ${n2(c2[0])} ${n2(c2[1])} ${n2(p2[0])} ${n2(p2[1])} c `;
      }
      return s;
    };
    const s = pt(r1, a0), e = pt(r0, a1);
    this.ops.push(`${pre}${n2(s[0])} ${n2(s[1])} m ${arco(r1, a0, a1)}${n2(e[0])} ${n2(e[1])} l ${r0 > 0 ? arco(r0, a1, a0) : ''}h ${op} Q`);
  }
  ancho(str, size = 10, bold = false) { let w = 0; for (const ch of String(str)) w += anchoByte(byteDe(ch), bold); return w * size / 1000; }
  // Recorta con «…» si no cabe en max
  recortar(str, max, size = 10, bold = false) {
    let s = String(str ?? '');
    if (this.ancho(s, size, bold) <= max) return s;
    while (s.length > 1 && this.ancho(s + '…', size, bold) > max) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }
  partir(str, max, size = 10, bold = false) {
    const out = [];
    for (const parrafo of String(str ?? '').split('\n')) {
      let linea = '';
      for (const w of parrafo.split(/\s+/).filter(Boolean)) {
        const prueba = linea ? `${linea} ${w}` : w;
        if (this.ancho(prueba, size, bold) <= max || !linea) linea = prueba; else { out.push(linea); linea = w; }
      }
      out.push(linea);
    }
    return out.map(l => this.ancho(l, size, bold) > max ? this.recortar(l, max, size, bold) : l);
  }
  // y = línea base del texto
  texto(str, x, y, { size = 10, bold = false, color = '#1f2933', align = 'left', max } = {}) {
    let s = String(str ?? '');
    if (max) s = this.recortar(s, max, size, bold);
    const w = this.ancho(s, size, bold);
    const X = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    let bytes = '';
    for (const ch of s) { const b = byteDe(ch); const c = String.fromCharCode(b); bytes += c === '(' || c === ')' || c === '\\' ? '\\' + c : c; }
    this.ops.push(`q ${rgb(color)} rg BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${n2(X)} ${n2(this._y(y))} Td (${bytes}) Tj ET Q`);
    return w;
  }
  blob() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalogo = add(null), paginas = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const gs = [...this.alfas].map(([a, nombre]) => [nombre, add(`<< /Type /ExtGState /ca ${a} /CA ${a} >>`)]);
    const recursos = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${gs.length ? ` /ExtGState << ${gs.map(([n, id]) => `/${n} ${id} 0 R`).join(' ')} >>` : ''} >>`;
    const kids = [];
    for (const ops of this.paginas) {
      const contenido = ops.join('\n');
      const c = add(`<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${paginas} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources ${recursos} /Contents ${c} 0 R >>`));
    }
    objs[catalogo - 1] = `<< /Type /Catalog /Pages ${paginas} 0 R >>`;
    objs[paginas - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }
}
