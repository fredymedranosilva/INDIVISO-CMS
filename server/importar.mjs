// Importación masiva desde Excel/CSV: pagos, egresos, proveedores, directorio, saldos iniciales y presupuesto.
// Cada fila pasa por el mismo motor que la captura manual (validaciones, pólizas, duplicados).
// «Validar» ejecuta todo dentro de una transacción y la revierte: el resultado de la vista previa
// es exactamente lo que ocurrirá al importar. Cada fila corre en su propio SAVEPOINT: una fila con
// error se descarta sin afectar a las demás.
import { fail, v, hoy, dbError, AppError, prorratear, mask } from './util.mjs';
import { sha256, audit } from './security.mjs';
import * as F from './finanzas.mjs';

// ---------- Normalización y lectura de celdas ----------
export const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compacto = s => norm(s).replace(/\b(torre|edificio|edif|seccion|depto|departamento|casa|local|unidad|vivienda)\b/g, '').replace(/\s+/g, '');
const txt = x => x == null ? '' : String(x).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
const pesosTxt = c => `$${(c / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Importe: 1230 · 1,230.50 · $1,230.50 · (1,230.50) · -1230 · número de Excel. Devuelve centavos.
export function importe(x, { negativo = false, campo = 'Importe' } = {}) {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) fail(400, `${campo} inválido.`);
    const c = Math.round(x * 100);
    if (c < 0 && !negativo) fail(400, `${campo} no puede ser negativo.`);
    if (Math.abs(c) > 100_000_000_00) fail(400, `${campo} excede el máximo.`);
    return c;
  }
  let s = txt(x).replace(/\s|\$|MXN|M\.N\./gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.230,50
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) fail(400, `${campo} «${txt(x)}» no es un importe válido.`);
  const c = Math.round(parseFloat(s) * 100) * (neg ? -1 : 1);
  if (c < 0 && !negativo) fail(400, `${campo} no puede ser negativo.`);
  if (Math.abs(c) > 100_000_000_00) fail(400, `${campo} excede el máximo.`);
  return c;
}

// Fecha: AAAA-MM-DD · DD/MM/AAAA · D/M/AA · número de serie de Excel.
export function fecha(x, campo = 'Fecha') {
  let s = typeof x === 'number' ? x : txt(x);
  if (s === '') return null;
  let out;
  if (typeof s === 'number' || /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n < 20000 || n > 80000) fail(400, `${campo} «${s}» no es una fecha válida.`);
    out = new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  } else {
    s = s.replace(/[T ].*$/, '');
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) out = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) out = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    else fail(400, `${campo} «${s}» no es una fecha válida (use DD/MM/AAAA).`);
  }
  const d = new Date(out + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== out) fail(400, `${campo} «${txt(x)}» no es una fecha válida.`);
  return out;
}

const SI = new Set(['si', 's', 'x', '1', 'true', 'verdadero', 'yes', 'activa', 'activo', 'pagado', 'pagada']);
const NO = new Set(['no', 'n', '0', 'false', 'falso', 'inactiva', 'inactivo']);
function bool(x, campo) {
  const s = norm(x);
  if (!s) return null;
  if (SI.has(s)) return true;
  if (NO.has(s)) return false;
  fail(400, `${campo} «${txt(x)}»: use Sí o No.`);
}

// Formas de pago: nombres o claves del catálogo del SAT (las que usan otros sistemas).
const METODO = { '01': 'efectivo', '1': 'efectivo', '02': 'cheque', '2': 'cheque', '03': 'transferencia', '3': 'transferencia', '04': 'tarjeta', '4': 'tarjeta', '28': 'tarjeta', '29': 'tarjeta' };
export function metodo(x, permitidos) {
  const s = norm(x);
  if (!s) return null;
  let m = METODO[s.replace(/\s.*$/, '')];
  if (!m) {
    if (/efectivo|caja|cash/.test(s)) m = 'efectivo';
    else if (/transfer|spei|electronica|banca en linea/.test(s)) m = 'transferencia';
    else if (/deposito|ventanilla/.test(s)) m = 'deposito';
    else if (/cheque/.test(s)) m = 'cheque';
    else if (/tarjeta|debito|credito|tpv|terminal/.test(s)) m = 'tarjeta';
    else if (/domicilia|cargo automatico/.test(s)) m = 'domiciliacion';
  }
  if (!m || !permitidos.includes(m)) fail(400, `Forma de pago «${txt(x)}» no reconocida. Use: ${permitidos.join(', ')}.`);
  return m;
}

const MESES = [['ene', 'enero', 'jan'], ['feb', 'febrero'], ['mar', 'marzo'], ['abr', 'abril', 'apr'], ['may', 'mayo'], ['jun', 'junio'], ['jul', 'julio'], ['ago', 'agosto', 'aug'], ['sep', 'sept', 'septiembre', 'setiembre'], ['oct', 'octubre'], ['nov', 'noviembre'], ['dic', 'diciembre', 'dec']];

export const MARCA_EJEMPLO = 'EJEMPLO · borre esta fila';
const esEjemplo = c => typeof c === 'string' && norm(c).startsWith('ejemplo');

// ---------- Búsquedas en catálogos ----------
function buscador(items, claves) {
  // claves(item) → lista de textos que identifican al item; se indexa normalizado y compactado.
  const idx = new Map();
  const add = (k, it) => { if (!k) return; const prev = idx.get(k); if (prev && prev !== it) idx.set(k, 'AMBIGUO'); else idx.set(k, it); };
  for (const it of items) for (const k of claves(it)) { add(norm(k), it); add(compacto(k), it); }
  return q => { const a = idx.get(norm(q)) ?? idx.get(compacto(q)); return a === 'AMBIGUO' ? 'AMBIGUO' : a || null; };
}

function catalogos(db, cid) {
  const unidades = db.prepare('SELECT id, clave, torre, referencia, activo FROM unidades WHERE condominio_id = ?').all(cid);
  const bancos = db.prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id WHERE b.condominio_id = ? AND b.activo = 1').all(cid);
  const partidas = db.prepare("SELECT id, codigo, nombre FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo").all(cid);
  const proveedores = db.prepare('SELECT id, nombre, rfc FROM proveedores WHERE condominio_id = ?').all(cid);
  return { unidades, bancos, partidas, proveedores };
}

const torreCorta = t => txt(t).replace(/^(torre|edificio|edif\.?|secci[oó]n|privada|bloque)\s*/i, '');
function buscarUnidad(aux, r) {
  const q = txt(r.unidad);
  if (!q) fail(400, 'Falta la unidad.');
  const cands = r.torre ? [`${torreCorta(r.torre)}-${q}`, `${r.torre} ${q}`, q] : [q];
  for (const c of cands) {
    const u = aux.unidad(c);
    if (u === 'AMBIGUO') fail(400, `La unidad «${c}» coincide con varias; use la clave exacta.`);
    if (u) return u;
  }
  fail(400, `No existe la unidad «${r.torre ? `${r.torre} ${q}` : q}».`);
}
function buscarBanco(aux, q) {
  const s = txt(q);
  if (!s) return undefined;
  if (/^(caja|efectivo|caja chica)$/i.test(norm(s))) return null;
  const b = aux.banco(s) || (/^\d{4}$/.test(s) ? aux.bancos.filter(x => (x.numero_mask || '').endsWith(s)) : aux.bancos.filter(x => norm(`${x.banco} ${x.nombre}`).includes(norm(s)) || norm(s).includes(norm(`${x.banco} ${x.nombre}`))));
  const lista = Array.isArray(b) ? b : b ? [b] : [];
  if (b === 'AMBIGUO' || lista.length > 1) fail(400, `La cuenta «${s}» coincide con varias; use el código de la hoja Catálogos.`);
  if (!lista.length) fail(400, `No existe la cuenta bancaria «${s}».`);
  return lista[0];
}
function buscarPartida(aux, q, ctx) {
  const s = txt(q);
  if (!s) return null;
  let k = aux.partida(s) || aux.partida(s.split(/\s*[·|-]\s*/)[0]);
  if (!k) {
    const ns = norm(s);
    const parc = aux.partidas.filter(p => ns.includes(norm(p.nombre)) || norm(p.nombre).includes(ns));
    if (parc.length === 1) k = parc[0];
    else if (parc.length > 1) {
      const exacta = parc.filter(p => ns.endsWith(norm(p.nombre)));
      if (exacta.length === 1) k = exacta[0]; else fail(400, `La partida «${s}» coincide con varias: ${parc.slice(0, 4).map(p => p.codigo).join(', ')}.`);
    }
  }
  if (k === 'AMBIGUO') fail(400, `La partida «${s}» coincide con varias; use su código.`);
  if (k) return k;
  if (!aux.crearPartidas) fail(400, `No existe la partida «${s}». Créela en Contabilidad o active «crear partidas nuevas».`);
  const nombre = s.replace(/^.*?\s-\s(?=\S)/, '').slice(0, 120) || s.slice(0, 120); // «Egresos Ordinarios - GF-001-Seguridad» → «GF-001-Seguridad»
  const usados = new Set(ctx.db.prepare('SELECT codigo FROM cuentas WHERE condominio_id = ?').all(ctx.cid).map(r => r.codigo));
  let n = 5600; while (usados.has(String(n)) && n < 5999) n++;
  if (n >= 5999) fail(400, 'No hay códigos libres para crear la partida.');
  const id = Number(ctx.db.prepare("INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, presupuestable) VALUES (?,?,?,'egreso','D',1)").run(ctx.cid, String(n), nombre).lastInsertRowid);
  const nueva = { id, codigo: String(n), nombre, nueva: true };
  aux.partidas.push(nueva); aux.partida = buscador(aux.partidas, p => [p.codigo, p.nombre]);
  aux.creadas.push(`${n} · ${nombre}`);
  return nueva;
}

// ---------- Definición de cada importación ----------
// columnas: clave → sinónimos de encabezado (normalizados). req: obligatorias.
const TIPOS = {
  pagos: {
    perm: 'capturar', nombre: 'pagos',
    columnas: {
      unidad: ['unidad', 'clave', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'condomino', 'referencia de pago', 'clave unidad', 'numero'],
      torre: ['torre', 'edificio', 'seccion', 'bloque'],
      fecha: ['fecha', 'fecha de pago', 'fecha pago', 'fecha del pago', 'fecha deposito'],
      importe: ['importe', 'monto', 'cantidad', 'pago', 'total', 'importe pagado', 'abono', 'deposito'],
      metodo: ['forma de pago', 'metodo', 'metodo de pago', 'forma pago', 'tipo de pago'],
      cuenta: ['cuenta bancaria', 'cuenta', 'banco', 'cuenta de caja o banco', 'cuenta deposito', 'caja o banco'],
      referencia: ['referencia', 'clave de rastreo', 'rastreo', 'folio', 'referencia bancaria', 'autorizacion', 'no operacion'],
      notas: ['comentarios', 'notas', 'observaciones', 'concepto', 'descripcion'],
    },
    req: ['unidad', 'fecha', 'importe'],
    vacia: r => !txt(r.importe) && !txt(r.fecha), // plantilla con todas las unidades: solo cuentan las que trae importe
    fila(ctx, r, aux, ocurr) {
      const u = buscarUnidad(aux, r);
      const f = fecha(r.fecha);
      if (f > hoy()) fail(400, 'La fecha de pago no puede ser futura.');
      const monto = importe(r.importe);
      if (!monto) fail(400, 'El importe debe ser mayor a cero.');
      // Cuenta: la de la fila; si no trae, caja para efectivo o la cuenta por defecto elegida al importar.
      const b = buscarBanco(aux, r.cuenta);
      let met = metodo(r.metodo, ['transferencia', 'deposito', 'efectivo', 'tarjeta', 'cheque', 'domiciliacion']);
      const banco = b !== undefined ? b : met === 'efectivo' ? null : aux.bancoDefecto;
      if (banco === undefined) fail(400, 'Indique la cuenta bancaria donde se recibió (o elija una cuenta por defecto).');
      if (!met) met = banco ? 'transferencia' : 'efectivo';
      if (!banco && met !== 'efectivo') fail(400, 'Un pago registrado en caja debe ser en efectivo.');
      const referencia = txt(r.referencia).slice(0, 60) || null;
      const base = [ctx.cid, u.id, f, monto, referencia || ''].join('|');
      const idem_key = `IMP-P-${sha256(`${base}|${ocurr(base)}`).slice(0, 48)}`;
      const res = F.registrarPago(ctx.db, ctx.cid, { unidad_id: u.id, fecha: f, monto_cents: monto, metodo: met, referencia, cuenta_banco_id: banco?.id ?? null,
        notas: txt(r.notas).slice(0, 300) || null, idem_key, confirmar_duplicado: aux.confirmarDuplicados }, ctx.user);
      if (res.repetido) return { accion: 'omitido', detalle: `Ya importado antes (recibo R-${res.folio}).` };
      return { accion: 'creado', detalle: `${u.clave} · ${pesosTxt(monto)} · recibo R-${res.folio}${res.saldo_favor ? ` · ${pesosTxt(res.saldo_favor)} a favor` : ''}`, monto };
    },
  },

  egresos: {
    // Mismas columnas que la plantilla de Vivook: Concepto, Proveedor, Importe, Fecha, Forma de pago, Cuenta bancaria,
    // Referencia, Clasificación presupuestal, Fondo y Comentarios. Si trae forma de pago o cuenta, el egreso queda pagado.
    perm: 'capturar', nombre: 'egresos',
    columnas: {
      concepto: ['concepto', 'descripcion', 'detalle'],
      proveedor: ['proveedor', 'beneficiario', 'razon social', 'nombre proveedor'],
      importe: ['importe', 'total', 'monto', 'importe total', 'cantidad'],
      fecha: ['fecha', 'fecha del gasto', 'fecha egreso', 'fecha de pago'],
      metodo: ['forma de pago', 'metodo', 'metodo de pago', 'forma pago'],
      cuenta: ['cuenta bancaria', 'cuenta', 'banco', 'cuenta de cargo', 'caja o banco'],
      referencia: ['referencia', 'clave de rastreo', 'rastreo', 'cheque', 'no cheque'],
      partida: ['clasificacion presupuestal', 'partida', 'partida presupuestal', 'clasificacion', 'cuenta de gasto', 'rubro', 'categoria'],
      fondo: ['fondo'],
      comentarios: ['comentarios', 'notas', 'observaciones'],
    },
    req: ['concepto', 'fecha', 'importe'],
    prep(ctx, aux) { aux.provNuevos = []; aux.fondos = ctx.db.prepare('SELECT id, nombre FROM fondos WHERE condominio_id = ? AND activo = 1').all(ctx.cid); },
    fila(ctx, r, aux, ocurr) {
      const f = fecha(r.fecha);
      if (f > hoy()) fail(400, 'La fecha del gasto no puede ser futura.');
      let concepto = txt(r.concepto);
      if (!concepto) fail(400, 'Falta el concepto.');
      const com = txt(r.comentarios);
      if (com && concepto.length + com.length + 3 <= 200) concepto = `${concepto} · ${com}`;
      concepto = concepto.slice(0, 200);
      const total = importe(r.importe);
      if (!total) fail(400, 'El importe debe ser mayor a cero.');
      const partida = buscarPartida(aux, r.partida, ctx) || aux.partidaDefecto || fail(400, 'Indique la clasificación presupuestal (o elija una por defecto).');
      // Fondo: Operación (ordinario), Reserva (extraordinario) o el nombre de un fondo específico.
      const fondoTxt = norm(r.fondo);
      let fondo = 'operacion', fondo_id = null;
      if (fondoTxt && !/ordinari|operacion|corriente|mantenimiento|general/.test(fondoTxt.replace(/extraordinari/, 'X'))) {
        const fe = aux.fondos.find(x => norm(x.nombre) === fondoTxt || fondoTxt.includes(norm(x.nombre)));
        if (fe) { fondo = 'reserva'; fondo_id = fe.id; }
        else if (/reserva|extraordinari/.test(fondoTxt)) fondo = 'reserva';
        else fail(400, `Fondo «${txt(r.fondo)}» no reconocido: use Operación, Reserva o el nombre de un fondo.`);
      }
      // Proveedor por nombre; si no existe se da de alta.
      let proveedor_id = null;
      const pn = txt(r.proveedor).slice(0, 160);
      if (pn) {
        let p = aux.proveedores.find(x => norm(x.nombre) === norm(pn));
        if (!p) {
          p = { id: Number(ctx.db.prepare('INSERT INTO proveedores (condominio_id, nombre, created_at) VALUES (?,?,?)').run(ctx.cid, pn, Date.now()).lastInsertRowid), nombre: pn };
          aux.proveedores.push(p); aux.provNuevos.push(pn);
        }
        proveedor_id = p.id;
      }
      const base = [ctx.cid, f, total, norm(concepto), proveedor_id || ''].join('|');
      const idem_key = `IMP-E-${sha256(`${base}|${ocurr(base)}`).slice(0, 48)}`;
      const e = F.crearEgreso(ctx.db, ctx.cid, { proveedor_id, cuenta_id: partida.id, fondo, fondo_id, fecha: f, concepto, subtotal_cents: total, iva_cents: 0, retenciones_cents: 0, idem_key }, ctx.user);
      if (e.repetido) return { accion: 'omitido', detalle: `Ya importado antes (E-${e.folio}).` };
      // Pago: si la fila trae forma de pago o cuenta (o así se indicó para todo el archivo), se registra pagado en la misma fecha.
      const b = buscarBanco(aux, r.cuenta);
      const met = metodo(r.metodo, ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'domiciliacion']);
      let pagado = '';
      if (aux.registrarPago || b !== undefined || met) {
        if (e.estado !== 'aprobado') pagado = ' · requiere aprobación; regístrelo como pagado después de aprobarlo';
        else {
          const banco = b === undefined ? (met === 'efectivo' ? null : aux.bancoDefecto ?? fail(400, 'Indique la cuenta bancaria de donde salió el pago (o elija una por defecto).')) : b;
          F.pagarEgreso(ctx.db, ctx.cid, e.id, { fecha_pago: f, metodo: met || (banco ? 'transferencia' : 'efectivo'), cuenta_banco_id: banco?.id ?? null, referencia: txt(r.referencia).slice(0, 60) || null }, ctx.user);
          pagado = ' · pagado';
        }
      }
      return { accion: 'creado', detalle: `E-${e.folio} · ${partida.codigo} · ${pesosTxt(total)}${e.estado === 'por_aprobar' && !pagado ? ' · espera aprobación' : ''}${pagado}`, monto: total };
    },
  },

  proveedores: {
    perm: 'capturar', nombre: 'proveedores',
    columnas: {
      nombre: ['nombre', 'razon social', 'proveedor', 'nombre o razon social'],
      rfc: ['rfc'], giro: ['giro', 'servicio', 'actividad', 'categoria'], email: ['correo', 'email', 'correo electronico', 'e mail'],
      telefono: ['telefono', 'tel', 'celular', 'movil'], clabe: ['clabe', 'cuenta clabe', 'clabe interbancaria'],
    },
    req: ['nombre'],
    fila(ctx, r, aux) {
      const d = v({ nombre: txt(r.nombre), rfc: txt(r.rfc) || null, giro: txt(r.giro) || null, email: txt(r.email) || null, telefono: txt(r.telefono) || null, clabe: txt(r.clabe).replace(/\s/g, '') || null },
        { nombre: 'str|max160', rfc: 'rfc|opt', giro: 'str|opt|max80', email: 'email|opt', telefono: 'str|opt|max30', clabe: 'str|opt|max18' });
      if (d.clabe && !/^\d{18}$/.test(d.clabe)) fail(400, 'La CLABE debe tener 18 dígitos.');
      const p = (d.rfc && aux.proveedores.find(x => x.rfc === d.rfc)) || aux.proveedores.find(x => norm(x.nombre) === norm(d.nombre));
      if (p) {
        const a = ctx.db.prepare('SELECT giro, email, telefono, clabe_mask, rfc FROM proveedores WHERE id = ?').get(p.id);
        const n = { giro: d.giro ?? a.giro, email: d.email ?? a.email, telefono: d.telefono ?? a.telefono, clabe_mask: mask(d.clabe) ?? a.clabe_mask, rfc: a.rfc ?? d.rfc };
        if (Object.keys(n).every(k => n[k] === a[k])) return { accion: 'omitido', detalle: `${p.nombre} · sin cambios` };
        ctx.db.prepare('UPDATE proveedores SET giro = ?, email = ?, telefono = ?, clabe_mask = ?, rfc = ? WHERE id = ?').run(n.giro, n.email, n.telefono, n.clabe_mask, n.rfc, p.id);
        return { accion: 'actualizado', detalle: `${p.nombre} · datos de contacto actualizados` };
      }
      const id = Number(ctx.db.prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, email, telefono, clabe_mask, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(ctx.cid, d.nombre, d.rfc, d.giro, d.email, d.telefono, mask(d.clabe), Date.now()).lastInsertRowid);
      aux.proveedores.push({ id, nombre: d.nombre, rfc: d.rfc });
      return { accion: 'creado', detalle: `${d.nombre}${d.rfc ? ` · ${d.rfc}` : ''}` };
    },
  },

  directorio: {
    perm: 'config', nombre: 'directorio',
    columnas: {
      unidad: ['clave', 'unidad', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'numero', 'vivienda casa departamento', 'no'],
      torre: ['torre', 'seccion', 'edificio', 'bloque', 'privada'],
      tipo: ['tipo', 'tipo de unidad'],
      superficie: ['m2', 'superficie', 'metros', 'metros cuadrados', 'area', 'superficie m2'],
      indiviso: ['indiviso', 'indiviso %', 'porcentaje de indiviso', 'proindiviso', 'factor', 'participacion'],
      cuota: ['cuota', 'cuota mensual', 'cuota ordinaria', 'mantenimiento', 'cuota de mantenimiento'],
      estado: ['ocupacion', 'estado', 'estatus ocupacion', 'ocupada'],
      activa: ['activa', 'estatus', 'estatus de vivienda', 'activo'],
      propietario: ['propietario', 'nombre', 'contacto principal', 'condomino', 'nombre propietario', 'contacto'],
      email: ['correo', 'email', 'correo propietario', 'e mail', 'correo electronico'],
      telefono: ['telefono', 'tel', 'celular', 'telefono propietario'],
      rfc: ['rfc', 'rfc propietario'],
      inquilino: ['inquilino', 'arrendatario', 'nombre inquilino'],
      email_inq: ['correo inquilino', 'email inquilino'],
      tel_inq: ['telefono inquilino', 'tel inquilino'],
      notas: ['notas', 'comentarios', 'observaciones'],
    },
    req: ['unidad'],
    prep(ctx, aux, filas) {
      // Indiviso escrito como fracción (0.0145) en lugar de porcentaje (1.45): se detecta por la suma del archivo.
      let suma = 0;
      for (const r of filas) { if (r.indiviso === '' || r.indiviso == null) continue; const n = parseFloat(String(r.indiviso).replace('%', '').replace(',', '.')); if (Number.isFinite(n)) suma += n; }
      aux.indivisoFraccion = suma > 0 && suma <= 1.0001;
      aux.personas = ctx.db.prepare('SELECT id, nombre, email, telefono, rfc FROM personas WHERE condominio_id = ? AND activo = 1').all(ctx.cid);
    },
    fila(ctx, r, aux) {
      const db = ctx.db;
      const q = txt(r.unidad); if (!q) fail(400, 'Falta la clave de la unidad.');
      let u = null;
      try { u = buscarUnidad(aux, r); } catch (e) { if (!/No existe/.test(e.message)) throw e; }
      const TIPOS_U = ['departamento', 'casa', 'local', 'oficina', 'bodega', 'estacionamiento'];
      const tipo = r.tipo ? TIPOS_U.find(t => norm(r.tipo).startsWith(t.slice(0, 4))) || fail(400, `Tipo «${txt(r.tipo)}» no reconocido: ${TIPOS_U.join(', ')}.`) : null;
      const est = norm(r.estado);
      const estado = !est ? null : /desocupad|vacant|vacia|libre/.test(est) ? 'vacante' : /renta|arrend/.test(est) ? 'renta' : /ocupad|habitad|propietario/.test(est) ? 'ocupada' : fail(400, `Ocupación «${txt(r.estado)}»: use Ocupada, Vacante o En renta.`);
      let ind = null;
      if (txt(r.indiviso)) {
        const n = parseFloat(txt(r.indiviso).replace('%', '').replace(',', '.'));
        if (!Number.isFinite(n) || n < 0 || n > 100) fail(400, `Indiviso «${txt(r.indiviso)}» inválido.`);
        ind = Math.round((aux.indivisoFraccion ? n * 100 : n) * 10000);
      }
      const cuota = txt(r.cuota) ? importe(r.cuota, { campo: 'Cuota' }) : null;
      const m2 = txt(r.superficie) ? Math.round(parseFloat(txt(r.superficie).replace(',', ''))) : null;
      if (m2 != null && (!Number.isFinite(m2) || m2 < 0 || m2 > 100000)) fail(400, 'Superficie inválida.');
      const activa = bool(r.activa, 'Activa');
      const torre = txt(r.torre).slice(0, 30) || null;
      const notas = txt(r.notas).slice(0, 300) || null;
      let accion, cambios = 0;
      if (u) {
        const a = db.prepare('SELECT * FROM unidades WHERE id = ?').get(u.id);
        const n = { torre: torre ?? a.torre, tipo: tipo ?? a.tipo, m2: m2 ?? a.m2, indiviso_ppm: ind ?? a.indiviso_ppm, cuota_cents: cuota ?? a.cuota_cents, estado: estado ?? a.estado, notas: notas ?? a.notas, activo: activa == null ? a.activo : activa ? 1 : 0 };
        if (Object.keys(n).some(k => n[k] !== a[k])) {
          db.prepare('UPDATE unidades SET torre = ?, tipo = ?, m2 = ?, indiviso_ppm = ?, cuota_cents = ?, estado = ?, notas = ?, activo = ? WHERE id = ?')
            .run(n.torre, n.tipo, n.m2, n.indiviso_ppm, n.cuota_cents, n.estado, n.notas, n.activo, u.id);
          cambios++;
        }
        accion = 'actualizado';
      } else {
        // «Torre 1» + «101» → clave «1-101» (las claves son únicas en el condominio; el número suele repetirse entre torres).
        const tc = torreCorta(torre);
        const clave = (torre && tc && /^\d/.test(q) && !norm(q).startsWith(norm(tc) + ' ') ? `${tc}-${q}` : q).slice(0, 20);
        const ref = aux.referenciaPago(db, ctx.cid, clave);
        const id = Number(db.prepare('INSERT INTO unidades (condominio_id, clave, torre, tipo, m2, indiviso_ppm, cuota_cents, referencia, estado, notas, activo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(ctx.cid, clave, torre, tipo || 'departamento', m2, ind ?? 0, cuota ?? 0, ref, estado || 'ocupada', notas, activa === false ? 0 : 1, Date.now()).lastInsertRowid);
        u = { id, clave, torre, referencia: ref, activo: 1 };
        aux.unidades.push(u); aux.unidad = buscador(aux.unidades, x => [x.clave, x.referencia, x.torre ? `${x.torre} ${x.clave}` : null]);
        accion = 'creado';
      }
      const pers = [];
      for (const [rol, nombre, email, tel, rfc] of [['propietario', r.propietario, r.email, r.telefono, r.rfc], ['inquilino', r.inquilino, r.email_inq, r.tel_inq, null]]) {
        const n = txt(nombre).slice(0, 120);
        if (!n) continue;
        const d = v({ email: txt(email).split(/[;,\s]+/)[0] || null, telefono: txt(tel).slice(0, 30) || null, rfc: txt(rfc) || null }, { email: 'email|opt', telefono: 'str|opt|max30', rfc: 'rfc|opt' });
        const vinculadas = db.prepare('SELECT p.* FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = ? ORDER BY up.id').all(u.id, rol);
        // Al exportar, varios propietarios salen como «A, B»: si coincide con los vinculados, no hay cambio.
        if (vinculadas.length > 1 && norm(vinculadas.map(x => x.nombre).join(', ')) === norm(n)) { pers.push(`${rol}: ${n}`); continue; }
        let p = vinculadas.find(x => norm(x.nombre) === norm(n)) || (d.email && aux.personas.find(x => x.email && x.email.toLowerCase() === d.email));
        if (!p) {
          p = { id: Number(db.prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, rfc, created_at) VALUES (?,?,?,?,?,?)').run(ctx.cid, n, d.email, d.telefono, d.rfc, Date.now()).lastInsertRowid), nombre: n, email: d.email };
          aux.personas.push(p); cambios++;
        } else {
          const otro = d.email && aux.personas.find(x => x.id !== p.id && x.email && x.email.toLowerCase() === d.email);
          const a = db.prepare('SELECT email, telefono, rfc FROM personas WHERE id = ?').get(p.id);
          const email = d.email && !otro ? d.email : a.email, telefono = d.telefono ?? a.telefono, rfcN = d.rfc ?? a.rfc; // lo que trae el archivo reemplaza; lo vacío se conserva
          if (email !== a.email || telefono !== a.telefono || rfcN !== a.rfc) { db.prepare('UPDATE personas SET email = ?, telefono = ?, rfc = ? WHERE id = ?').run(email, telefono, rfcN, p.id); cambios++; }
        }
        cambios += db.prepare('INSERT OR IGNORE INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)').run(u.id, p.id, rol).changes;
        pers.push(`${rol}: ${n}`);
      }
      if (accion === 'actualizado' && !cambios) return { accion: 'omitido', detalle: `${u.clave} · sin cambios` };
      return { accion, detalle: `${u.clave}${pers.length ? ` · ${pers.join(' · ')}` : ''}${cuota != null ? ` · cuota ${pesosTxt(cuota)}` : ''}${ind != null ? ` · indiviso ${(ind / 10000).toFixed(4)}%` : ''}` };
    },
  },

  saldos: {
    perm: 'config', nombre: 'saldos iniciales',
    columnas: {
      unidad: ['unidad', 'clave', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'numero'],
      torre: ['torre', 'edificio', 'seccion'],
      saldo: ['saldo', 'saldo final', 'saldo inicial', 'saldo actual', 'balance'],
      adeudo: ['adeudo', 'cargo', 'debe', 'cuentas por cobrar', 'por cobrar', 'adeudo inicial'],
      favor: ['saldo a favor', 'a favor', 'anticipo', 'abono', 'haber'],
      concepto: ['concepto', 'comentarios', 'notas'],
    },
    req: ['unidad'],
    vacia: r => !txt(r.saldo) && !txt(r.adeudo) && !txt(r.favor),
    fila(ctx, r, aux) {
      const u = buscarUnidad(aux, r);
      let monto;
      if (txt(r.saldo)) {
        const s = txt(r.saldo), aFavor = /favor/i.test(s); // «$-1,200.00 (A favor)», como lo exportan otros sistemas
        monto = importe(aFavor ? s.replace(/\(?\s*a\s+favor\s*\)?/i, '') : r.saldo, { negativo: true, campo: 'Saldo' });
        if (aFavor) monto = -Math.abs(monto);
      } else monto = (importe(r.adeudo, { campo: 'Adeudo' }) || 0) - (importe(r.favor, { campo: 'Saldo a favor' }) || 0);
      if (!monto) return { accion: 'omitido', detalle: `${u.clave} · saldo en cero` };
      const res = F.saldoInicial(ctx.db, ctx.cid, { unidad_id: u.id, monto_cents: monto, fecha: aux.fechaCorte, concepto: txt(r.concepto).slice(0, 120) || null }, ctx.user);
      if (res.omitido) return { accion: 'omitido', detalle: `${u.clave} · ${res.motivo}` };
      return { accion: 'creado', detalle: `${u.clave} · ${res.tipo === 'adeudo' ? 'adeudo' : 'saldo a favor'} ${pesosTxt(res.monto)}`, monto: res.monto };
    },
  },

  presupuesto: {
    perm: 'capturar', nombre: 'presupuesto',
    columnas: {
      partida: ['partida', 'cuenta', 'clasificacion presupuestal', 'concepto', 'codigo', 'rubro', 'clasificacion'],
      anual: ['anual', 'total', 'total anual', 'importe anual', 'presupuesto anual'],
      mensual: ['mensual', 'importe mensual', 'monto mensual'],
      ...Object.fromEntries(MESES.map((n, i) => [`m${i + 1}`, [...n, String(i + 1), `mes ${i + 1}`]])),
    },
    req: ['partida'],
    prep(ctx, aux) {
      const p = ctx.db.prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?').get(aux.presupuestoId, ctx.cid) || fail(404, 'Presupuesto no encontrado.');
      if (p.estado !== 'borrador') fail(409, 'Solo se importa a un presupuesto en borrador.');
      aux.vistas = new Set();
    },
    fila(ctx, r, aux) {
      const k = buscarPartida(aux, r.partida, ctx) || fail(400, 'Falta la partida.');
      if (aux.vistas.has(k.id)) fail(400, `La partida ${k.codigo} aparece dos veces en el archivo.`);
      const meses = Array.from({ length: 12 }, (_, i) => r[`m${i + 1}`]);
      let montos;
      if (meses.some(x => txt(x) !== '')) montos = meses.map((x, i) => importe(x, { campo: MESES[i][1] }) || 0);
      else if (txt(r.mensual)) montos = Array(12).fill(importe(r.mensual, { campo: 'Mensual' }));
      else if (txt(r.anual)) montos = prorratear(importe(r.anual, { campo: 'Anual' }), Array(12).fill(1));
      else fail(400, 'Indique los importes por mes, mensual o anual.');
      F.guardarLineasPresupuesto(ctx.db, ctx.cid, aux.presupuestoId, montos.map((m, i) => ({ cuenta_id: k.id, mes: i + 1, monto_cents: m })));
      aux.vistas.add(k.id);
      const total = montos.reduce((a, b) => a + b, 0);
      return { accion: 'actualizado', detalle: `${k.codigo} · ${k.nombre} · ${pesosTxt(total)} anual${k.nueva ? ' · partida nueva' : ''}`, monto: total };
    },
  },
};

// Asigna cada encabezado a una columna conocida: primero coincidencia exacta, luego por prefijo.
function mapear(encabezados, T) {
  const mapa = {}, usados = new Set();
  const hs = encabezados.map(h => norm(h));
  for (const pasada of ['exacta', 'prefijo']) {
    for (const [k, sin] of Object.entries(T.columnas)) {
      if (k in mapa) continue;
      const i = hs.findIndex((h, j) => h && !usados.has(j) && sin.some(s => pasada === 'exacta' ? h === s : (h.startsWith(s + ' ') || h.endsWith(' ' + s))));
      if (i >= 0) { mapa[k] = i; usados.add(i); }
    }
  }
  return { mapa, ignoradas: encabezados.map((h, i) => txt(h) && !usados.has(i) ? txt(h) : null).filter(Boolean) };
}

export function importar(ctx, tipo, body, { perms, rolPuede, referenciaPago }) {
  const T = TIPOS[tipo] || fail(404, 'Tipo de importación desconocido.');
  if (!perms[T.perm].includes(ctx.rol)) fail(403, 'No tiene permiso para esta importación.');
  const b = v(body, { filas: 'arr', aplicar: 'bool', archivo: 'str|opt|max160' });
  const op = body.opciones && typeof body.opciones === 'object' ? body.opciones : {};
  const filas = b.filas.map(f => Array.isArray(f) ? f.slice(0, 80).map(c => typeof c === 'number' ? c : txt(c).slice(0, 400)) : []);
  // El encabezado puede no estar en la primera fila (títulos, logotipos): se busca en las primeras 15.
  let h = -1, m = null;
  for (let i = 0; i < Math.min(15, filas.length); i++) {
    const r = mapear(filas[i], T);
    if (T.req.every(k => k in r.mapa)) { h = i; m = r; break; }
  }
  if (h < 0) {
    const nombres = T.req.map(k => T.columnas[k][0]).join(', ');
    fail(400, `No se encontró el renglón de encabezados. Columnas obligatorias: ${nombres}. Descargue la plantilla para ver el formato.`);
  }
  // Las plantillas traen 3 filas de ejemplo marcadas «EJEMPLO · borre esta fila»: nunca se importan.
  let ejemplos = 0;
  const datos = filas.slice(h + 1).map((arr, i) => ({ n: h + i + 2, arr, r: Object.fromEntries(Object.entries(m.mapa).map(([k, j]) => [k, arr[j] ?? ''])) }))
    .filter(x => { if (x.arr.some(c => esEjemplo(c))) { ejemplos++; return false; } return true; })
    .filter(x => Object.values(x.r).some(c => txt(c) !== '') && !T.vacia?.(x.r));
  if (!datos.length) fail(400, ejemplos ? 'El archivo solo trae las filas de ejemplo: capture sus datos debajo de ellas (o sobre ellas, borrando la marca «EJEMPLO»).' : 'El archivo no tiene filas con datos debajo de los encabezados.');
  const db = ctx.db;
  const resultados = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const cat = catalogos(db, ctx.cid);
    const aux = {
      ...cat, creadas: [], referenciaPago,
      unidad: buscador(cat.unidades, x => [x.clave, x.referencia, x.torre ? `${x.torre} ${x.clave}` : null]),
      banco: buscador(cat.bancos, x => [x.codigo, `${x.banco} ${x.nombre}`]),
      partida: buscador(cat.partidas, x => [x.codigo, x.nombre, `${x.codigo} ${x.nombre}`]),
      confirmarDuplicados: !!op.confirmar_duplicados, registrarPago: !!op.registrar_pago,
      crearPartidas: !!op.crear_partidas && rolPuede('config'),
      presupuestoId: Number(op.presupuesto_id) || null,
      fechaCorte: tipo === 'saldos' ? (v({ f: op.fecha_corte }, { f: 'date' }).f) : null,
    };
    if (op.cuenta_banco_id) aux.bancoDefecto = cat.bancos.find(x => x.id === Number(op.cuenta_banco_id)) || fail(400, 'Cuenta bancaria por defecto inválida.');
    if (op.partida_id) aux.partidaDefecto = cat.partidas.find(x => x.id === Number(op.partida_id)) || fail(400, 'Partida por defecto inválida.');
    if (aux.fechaCorte && aux.fechaCorte > hoy()) fail(400, 'La fecha de corte no puede ser futura.');
    T.prep?.(ctx, aux, datos.map(d => d.r));
    const veces = new Map();
    const ocurr = base => { const n = (veces.get(base) || 0) + 1; veces.set(base, n); return n; };
    for (const { n, r } of datos) {
      db.exec('SAVEPOINT fila');
      try {
        const out = T.fila(ctx, r, aux, ocurr);
        db.exec('RELEASE fila');
        resultados.push({ n, ok: true, ...out });
      } catch (e) {
        db.exec('ROLLBACK TO fila'); db.exec('RELEASE fila');
        const err = e instanceof AppError ? e : dbError(e);
        if (!err) throw e;
        resultados.push({ n, ok: false, error: err.message, code: err.code });
      }
    }
    const resumen = {
      filas: resultados.length, validas: resultados.filter(r => r.ok && r.accion !== 'omitido').length, omitidas: resultados.filter(r => r.accion === 'omitido').length,
      errores: resultados.filter(r => !r.ok).length, creados: resultados.filter(r => r.accion === 'creado').length, actualizados: resultados.filter(r => r.accion === 'actualizado').length,
      total_cents: resultados.filter(r => r.ok && r.monto).reduce((a, r) => a + r.monto, 0),
      partidas_nuevas: aux.creadas, proveedores_nuevos: aux.provNuevos || [], ejemplos,
    };
    const aplicar = b.aplicar && resumen.validas > 0;
    if (aplicar) {
      audit(db, { usuario_id: ctx.user.id, condominio_id: ctx.cid, ip: ctx.ip, accion: `importacion_${tipo}`, entidad: 'importacion',
        detalle: { archivo: b.archivo, filas: resumen.filas, aplicadas: resumen.validas, omitidas: resumen.omitidas, errores: resumen.errores, total_cents: resumen.total_cents } });
      db.exec('COMMIT');
    } else db.exec('ROLLBACK');
    const columnas = Object.fromEntries(Object.entries(m.mapa).map(([k, j]) => [k, txt(filas[h][j])]));
    return { aplicado: aplicar, encabezado: h + 1, columnas, ignoradas: m.ignoradas, resumen, filas: resultados };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw e;
  }
}

// Catálogos para las plantillas (hoja «Catálogos»).
export function catalogosPlantilla(db, cid) {
  const c = catalogos(db, cid);
  return {
    unidades: db.prepare(`SELECT u.clave, u.torre, u.referencia, u.tipo, u.m2, u.indiviso_ppm, u.cuota_cents, u.estado, u.activo, u.notas,
      (SELECT GROUP_CONCAT(nombre, ', ') FROM (SELECT p.nombre FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario' ORDER BY up.id)) AS propietario,
      (SELECT p.email FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario' AND p.email IS NOT NULL LIMIT 1) AS email,
      (SELECT p.telefono FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario' AND p.telefono IS NOT NULL LIMIT 1) AS telefono,
      (SELECT p.rfc FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario' AND p.rfc IS NOT NULL LIMIT 1) AS rfc,
      (SELECT GROUP_CONCAT(nombre, ', ') FROM (SELECT p.nombre FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'inquilino' ORDER BY up.id)) AS inquilino,
      (SELECT p.email FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'inquilino' AND p.email IS NOT NULL LIMIT 1) AS email_inq,
      (SELECT p.telefono FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'inquilino' AND p.telefono IS NOT NULL LIMIT 1) AS tel_inq
      FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave`).all(cid),
    bancos: c.bancos.map(b => ({ codigo: b.codigo, nombre: `${b.banco} ${b.nombre}`, numero: b.numero_mask, fondo: b.fondo, id: b.id })),
    partidas: c.partidas,
    proveedores: db.prepare('SELECT nombre, rfc, giro, email, telefono FROM proveedores WHERE condominio_id = ? AND activo = 1 ORDER BY nombre').all(cid),
    fondos: db.prepare('SELECT nombre FROM fondos WHERE condominio_id = ? AND activo = 1 ORDER BY nombre').all(cid).map(f => f.nombre),
  };
}
