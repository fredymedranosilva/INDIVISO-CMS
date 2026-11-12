// Excel sin dependencias: lee .xlsx / .csv / texto pegado y escribe .xlsx (plantillas y exportaciones).
// Un .xlsx es un ZIP de XML: se descomprime con DecompressionStream (nativo del navegador).

// ---------- Lectura ----------
export async function leerTabla(file) {
  const nombre = file.name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) return leerXlsx(buf);
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new Error('Formato .xls antiguo: en Excel use «Guardar como» → Libro de Excel (.xlsx) o CSV.');
  if (/\.(xlsx|xlsm)$/.test(nombre)) throw new Error('El archivo .xlsx está dañado o no es un libro de Excel.');
  return leerTexto(decodificar(buf));
}

// CSV de Excel en Windows suele venir en ANSI (Windows-1252), no en UTF-8.
function decodificar(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

// CSV, TSV o celdas copiadas de Excel. Respeta comillas y saltos de línea dentro de comillas.
export function leerTexto(texto) {
  const t = texto.replace(/^﻿/, '');
  const primera = t.split(/\r?\n/, 1)[0];
  const cuenta = ch => (primera.match(new RegExp(ch === '\t' ? '\\t' : ch, 'g')) || []).length;
  const sep = ['\t', ';', ','].sort((a, b) => cuenta(b) - cuenta(a))[0];
  const filas = []; let fila = [], cel = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else q = false; }
      else cel += c;
    } else if (c === '"' && cel === '') q = true;
    else if (c === sep) { fila.push(cel); cel = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; fila.push(cel); filas.push(fila); fila = []; cel = ''; }
    else cel += c;
  }
  if (cel !== '' || fila.length) { fila.push(cel); filas.push(fila); }
  return filas.map(f => f.map(s => s.trim()));
}

async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('El archivo no es un libro de Excel válido.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const archivos = new Map();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const nombre = dec.decode(buf.subarray(p + 46, p + 46 + ln));
    archivos.set(nombre, { metodo, comp, off });
    p += 46 + ln + le + lc;
  }
  return async nombre => {
    const e = archivos.get(nombre.replace(/^\//, ''));
    if (!e) return null;
    const ini = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const datos = buf.subarray(ini, ini + e.comp);
    if (e.metodo === 0) return dec.decode(datos);
    if (e.metodo !== 8) throw new Error('Compresión no soportada en el archivo.');
    if (typeof DecompressionStream === 'undefined') throw new Error('Su navegador no puede leer .xlsx; actualícelo o guarde el archivo como CSV.');
    const s = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return dec.decode(await new Response(s).arrayBuffer());
  };
}

const xml = s => new DOMParser().parseFromString(s, 'application/xml');
const tags = (n, t) => [...n.getElementsByTagNameNS('*', t)];
const colDe = ref => { let c = 0; for (const ch of ref.replace(/\d+$/, '')) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };

async function leerXlsx(buf) {
  const leer = await unzip(buf);
  const wb = await leer('xl/workbook.xml');
  if (!wb) throw new Error('El archivo no es un libro de Excel válido.');
  const hoja = tags(xml(wb), 'sheet')[0];
  const rid = hoja?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || hoja?.getAttribute('r:id');
  const rels = xml(await leer('xl/_rels/workbook.xml.rels') || '<x/>');
  let destino = tags(rels, 'Relationship').find(r => r.getAttribute('Id') === rid)?.getAttribute('Target') || 'worksheets/sheet1.xml';
  destino = destino.startsWith('/') ? destino.slice(1) : 'xl/' + destino.replace(/^\.\//, '');
  const sst = await leer('xl/sharedStrings.xml');
  const textos = sst ? tags(xml(sst), 'si').map(si => tags(si, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('')) : [];
  const sh = await leer(destino);
  if (!sh) throw new Error('No se encontró la primera hoja del libro.');
  const filas = [];
  for (const row of tags(xml(sh), 'row')) {
    const r = (+row.getAttribute('r') || filas.length + 1) - 1;
    const f = filas[r] = [];
    let col = 0;
    for (const c of tags(row, 'c')) {
      const ref = c.getAttribute('r'); if (ref) col = colDe(ref);
      const t = c.getAttribute('t'), vv = tags(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = textos[+vv] ?? '';
      else if (t === 'inlineStr') val = tags(c, 't').map(x => x.textContent).join('');
      else if (t === 'b') val = vv === '1' ? 'Sí' : 'No';
      else if (t === 'str' || t === 'e') val = vv;
      else val = vv === '' ? '' : Number(vv);
      f[col++] = val;
    }
  }
  return Array.from(filas, f => Array.from(f || [], x => x ?? ''));
}

// ---------- Escritura (.xlsx mínimo: varias hojas, encabezado en negritas y fijo) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(archivos) {
  const enc = new TextEncoder(), partes = [], central = []; let off = 0;
  for (const [nombre, contenido] of archivos) {
    const n = enc.encode(nombre), d = enc.encode(contenido), crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    partes.push(new Uint8Array(h.buffer), n, d); central.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + d.length;
  }
  const tam = central.reduce((a, x) => a + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, archivos.length, true); e.setUint16(10, archivos.length, true); e.setUint32(12, tam, true); e.setUint32(16, off, true);
  return new Blob([...partes, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const X = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letra = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// hojas: [{ nombre, filas: [[...]], anchos?, ejemplos?: [índices], titulo?: [líneas], moneda?: [columnas], total?: bool, pct?: [columnas], subtotales?: [índices] }]
// Diseño CMS: banda de título en verde CMS con el condominio y el periodo en dorado, encabezados en verde 2 con filete
// dorado, renglones alternos en marfil, subtotales en verde claro y fila de total en verde CMS. Las columnas de importes
// llevan formato de moneda (se detectan por su encabezado o se indican en `moneda`). Las filas cuyo texto empieza con
// «Subtotal» se resaltan solas. La información no cambia: solo la presentación.
const MONEDA_RE = /importe|monto|total|saldo|cuota|pagad|emitid|cobrad|adeudo|vencid|cargo|abono|ingreso|egreso|presupuesto|ejercido|disponible|subtotal|iva|recargo|favor|anterior|final|aportaci|aplicaci|por vencer|variaci|real|acumulad|^\d|d[ií]as?$|^(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/i;
// Índices de estilo (ver styles.xml más abajo)
const S = { enc: 1, ej: 2, txt: 3, txtZ: 4, mon: 5, monZ: 6, pct: 7, pctZ: 8, subT: 9, subM: 10, subP: 11, totT: 12, totM: 13, totP: 14, tit: 15, sub: 16, meta: 17, ejM: 18, num: 19, numZ: 20 };
export function escribirXlsx(hojas) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const hojaXml = h => {
    const tit = h.titulo || [], off = tit.length ? tit.length + 1 : 0, enc = h.filas[0] || [];
    const ncol = Math.max(1, enc.length);
    const money = new Set(h.moneda || (h.titulo ? enc.map((t, j) => MONEDA_RE.test(String(t)) && !/d[ií]as|cuotas vencidas|^n[uú]m|unidades|pagos$|documentos|movimientos|%/i.test(String(t)) ? j : -1).filter(j => j >= 0) : []));
    const pct = new Set(h.pct || []);
    const anchos = h.anchos || enc.map((_, j) => Math.min(52, Math.max(money.has(j) ? 15 : 10, ...h.filas.slice(0, 300).map(f => String(f[j] ?? '').length + 3))));
    const ult = h.filas.length - 1;
    const subt = new Set(h.subtotales || h.filas.map((f, i) => i > 0 && f.slice(0, 3).some(c => typeof c === 'string' && /^subtotal\b/i.test(c)) ? i : -1).filter(i => i > 0));
    const celda = (v, r, st) => {
      if (v == null || v === '') return st ? `<c r="${r}" s="${st}"/>` : '';
      const s2 = st ? ` s="${st}"` : '';
      return typeof v === 'number' && Number.isFinite(v) ? `<c r="${r}"${s2}><v>${v}</v></c>` : `<c r="${r}" t="inlineStr"${s2}><is><t xml:space="preserve">${X(v)}</t></is></c>`;
    };
    // Banda de título: cada línea ocupa todo el ancho de la tabla (celdas combinadas).
    const estT = [S.tit, S.sub, S.meta];
    const filasT = tit.map((t, i) => { const st = estT[Math.min(i, 2)];
      return `<row r="${i + 1}" ht="${i === 0 ? 30 : i === 1 ? 20 : 17}" customHeight="1">${Array.from({ length: ncol }, (_, j) => celda(j ? '' : t, `${letra(j)}${i + 1}`, st)).join('')}</row>`; }).join('');
    const filas = h.filas.map((f, i) => {
      const n = i + 1 + off, esTotal = h.total && i === ult && i > 0, esSub = subt.has(i), z = !esTotal && !esSub && i % 2 === 0;
      return `<row r="${n}"${i === 0 ? ' ht="24" customHeight="1"' : ''}>${(i === 0 ? enc : Array.from({ length: Math.max(f.length, ncol) }, (_, j) => f[j])).map((v, j) => {
        let st;
        if (i === 0) st = S.enc;
        else if (h.ejemplos?.includes(i)) st = typeof v === 'number' && money.has(j) ? S.ejM : S.ej;
        else if (esTotal) st = typeof v === 'number' ? (pct.has(j) ? S.totP : money.has(j) ? S.totM : S.totT) : S.totT;
        else if (esSub) st = typeof v === 'number' ? (pct.has(j) ? S.subP : money.has(j) ? S.subM : S.subT) : S.subT;
        else if (typeof v === 'number') st = pct.has(j) ? (z ? S.pctZ : S.pct) : money.has(j) ? (z ? S.monZ : S.mon) : (z ? S.numZ : S.num);
        else st = z ? S.txtZ : S.txt;
        return celda(v, `${letra(j)}${n}`, st);
      }).join('')}</row>`;
    }).join('');
    const ref = enc.length ? `A${off + 1}:${letra(enc.length - 1)}${off + h.filas.length}` : null;
    const merges = ncol > 1 ? tit.map((_, i) => `<mergeCell ref="A${i + 1}:${letra(ncol - 1)}${i + 1}"/>`) : [];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetPr><tabColor rgb="FF003329"/><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="100"><pane ySplit="${off + 1}" topLeftCell="A${off + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="16"/><cols>${anchos.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${filasT}${off ? `<row r="${off}" ht="8" customHeight="1"/>` : ''}${filas}</sheetData>`
      + `${ref && h.filas.length > 1 && !h.ejemplos ? `<autoFilter ref="${ref}"/>` : ''}${merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : ''}`
      + `<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="${enc.length > 7 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
      + `<headerFooter><oddFooter>&amp;L&amp;8&amp;K6B7280${X(tit[1] || h.nombre)}&amp;R&amp;8&amp;K6B7280Página &amp;P de &amp;N</oddFooter></headerFooter></worksheet>`;
  };
  const archivos = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${X(h.nombre.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red]-&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00"/></numFmts>`
      + `<fonts count="7"><font><sz val="10.5"/><color rgb="FF1F2937"/><name val="Calibri"/></font><font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><i/><sz val="10.5"/><color rgb="FF8A5A1F"/><name val="Calibri"/></font><font><b/><sz val="10.5"/><color rgb="FF001F19"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFE6A24D"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/></font></fonts>`
      + `<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBEFD9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF001F19"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF003329"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBF9F4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EDE9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF6F3EC"/><bgColor indexed="64"/></patternFill></fill></fills>`
      + `<borders count="6"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE3DCCB"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FFE6A24D"/></bottom><diagonal/></border><border><left/><right/><top style="medium"><color rgb="FFE6A24D"/></top><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF003329"/></top><bottom style="thin"><color rgb="FFE3DCCB"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FFC58430"/></bottom><diagonal/></border></borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="21">`
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
      + `<xf numFmtId="0" fontId="1" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
      + `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="164" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="165" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="3" fillId="6" borderId="4" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="164" fontId="3" fillId="6" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="165" fontId="3" fillId="6" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="1" fillId="3" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="166" fontId="1" fillId="3" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="165" fontId="1" fillId="3" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>`
      + `<xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>`
      + `<xf numFmtId="0" fontId="6" fillId="7" borderId="5" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>`
      + `<xf numFmtId="164" fontId="2" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
      + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...hojas.map((h, i) => [`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h)]),
  ];
  return zip(archivos);
}

// Si la página corre dentro de un visor que entrega archivos por su cuenta (demo publicada), lo usa.
export async function guardarBlob(blob, nombre) {
  if (window.__guardarArchivo && await window.__guardarArchivo(blob, nombre)) return;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
