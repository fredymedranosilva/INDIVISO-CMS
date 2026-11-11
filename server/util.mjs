// Utilidades compartidas: errores de negocio, fechas y validación de entradas.
export class AppError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, msg, code) => { throw new AppError(status, msg, code); };

// Traduce errores de la base (restricciones, triggers) a mensajes claros sin filtrar internos.
export function dbError(e) {
  const m = String(e.message || '');
  if (m.includes('INMUTABLE')) return new AppError(409, m.slice(m.indexOf('INMUTABLE') + 11) || 'Registro inmutable.', 'INMUTABLE');
  if (m.includes('PERIODO_CERRADO')) return new AppError(409, 'El periodo contable está cerrado; el movimiento no puede registrarse en esa fecha.', 'PERIODO_CERRADO');
  if (m.includes('UNIQUE constraint failed')) return new AppError(409, 'El registro ya existe (se evitó un duplicado).', 'DUPLICADO');
  if (m.includes('CHECK constraint failed')) return new AppError(400, 'Los datos no cumplen las reglas de validación.', 'VALIDACION');
  if (m.includes('FOREIGN KEY constraint failed')) return new AppError(400, 'Referencia a un registro inexistente.', 'REFERENCIA');
  return null;
}

const pad = n => String(n).padStart(2, '0');
export const hoy = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const periodoDe = fecha => fecha.slice(0, 7);
// Fechas de operaciones de dinero ya ocurridas (cobros, pagos, gastos): ni futuras ni absurdamente antiguas.
export function fechaOperable(fecha, campo = 'La fecha') {
  if (fecha > hoy()) fail(400, `${campo} no puede ser futura.`);
  if (fecha < '2000-01-01') fail(400, `${campo} es demasiado antigua.`);
  return fecha;
}
export const periodoActual = () => periodoDe(hoy());
export function addMonths(periodo, n) {
  const [y, m] = periodo.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function addDays(fecha, n) {
  const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const diffDays = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
export function finDeMes(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  return `${periodo}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const nombrePeriodo = p => `${MESES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;

// ---------- Validación estricta de entradas ----------
export const isDate = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isPeriodo = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// v(body, { campo: 'tipo|opcional' }) → objeto limpio o error 400.
export function v(body, spec) {
  const out = {};
  const src = body && typeof body === 'object' ? body : {};
  for (const [k, rule] of Object.entries(spec)) {
    const [type, ...mods] = rule.split('|');
    const opt = mods.includes('opt');
    let val = src[k];
    if (val === undefined || val === null || val === '') {
      if (opt) { out[k] = null; continue; }
      fail(400, `Falta el campo «${k}».`);
    }
    switch (type) {
      case 'str': {
        if (typeof val !== 'string') fail(400, `«${k}» debe ser texto.`);
        val = val.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        const max = +(mods.find(m => m.startsWith('max'))?.slice(3) || 200);
        if (val.length > max) fail(400, `«${k}» excede ${max} caracteres.`);
        if (!val && !opt) fail(400, `Falta el campo «${k}».`);
        break;
      }
      case 'int': {
        if (typeof val === 'string' && /^-?\d+$/.test(val)) val = Number(val);
        if (!Number.isSafeInteger(val)) fail(400, `«${k}» debe ser un entero.`);
        const min = mods.find(m => m.startsWith('min'));
        if (min && val < +min.slice(3)) fail(400, `«${k}» es menor al mínimo permitido.`);
        const max = mods.find(m => m.startsWith('max'));
        if (max && val > +max.slice(3)) fail(400, `«${k}» excede el máximo permitido.`);
        break;
      }
      case 'cents': { // importes siempre en centavos enteros: sin errores de redondeo
        if (typeof val === 'string' && /^\d+$/.test(val)) val = Number(val);
        if (!Number.isSafeInteger(val) || val < 0) fail(400, `«${k}» debe ser un importe válido.`);
        if (val > 100_000_000_00) fail(400, `«${k}» excede el importe máximo.`);
        if (!mods.includes('zero') && val === 0) fail(400, `«${k}» debe ser mayor a cero.`);
        break;
      }
      case 'date': if (!isDate(val)) fail(400, `«${k}» debe ser una fecha AAAA-MM-DD.`); break;
      case 'periodo': if (!isPeriodo(val)) fail(400, `«${k}» debe ser un periodo AAAA-MM.`); break;
      case 'bool': val = val === true || val === 1 || val === '1' || val === 'true'; break;
      case 'email':
        if (typeof val !== 'string' || !/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(val.trim())) fail(400, `«${k}» no es un correo válido.`);
        val = val.trim().toLowerCase(); break;
      case 'rfc':
        if (typeof val !== 'string' || !/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/i.test(val.trim())) fail(400, `«${k}» no es un RFC válido.`);
        val = val.trim().toUpperCase(); break;
      case 'uuid':
        if (typeof val !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val.trim())) fail(400, `«${k}» no es un UUID de CFDI válido.`);
        val = val.trim().toUpperCase(); break;
      case 'enum': {
        const opts = mods.filter(m => m !== 'opt');
        if (!opts.includes(val)) fail(400, `«${k}» tiene un valor no permitido.`);
        break;
      }
      case 'arr': if (!Array.isArray(val)) fail(400, `«${k}» debe ser una lista.`); if (val.length > 5000) fail(400, `«${k}» es demasiado larga.`); break;
      case 'key': if (typeof val !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(val)) fail(400, `«${k}» inválido.`); break;
      default: fail(500, 'Regla de validación desconocida');
    }
    out[k] = val;
  }
  return out;
}

// Reparte un total en partes proporcionales a los pesos sin perder centavos (residuo mayor).
export function prorratear(total, pesos) {
  const sum = pesos.reduce((a, b) => a + b, 0);
  if (sum <= 0) fail(400, 'No hay base de prorrateo (indivisos en cero).');
  const raw = pesos.map(w => total * w / sum);
  const base = raw.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { base[i]++; rest--; } });
  return base;
}

export const mask = s => s ? '•••• ' + String(s).replace(/\s/g, '').slice(-4) : null;
