// API por condominio. Cada ruta declara el permiso requerido; cada escritura corre en una
// transacción y deja rastro en la bitácora encadenada dentro de la misma transacción.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tx, DATA_DIR } from './db.mjs';
import { audit, sha256, token, hashPassword, verifyAuditChain, rateLimit as rl } from './security.mjs';
import { fail, v, hoy, periodoDe, periodoActual, addMonths, mask } from './util.mjs';
import * as F from './finanzas.mjs';
import * as R from './reportes.mjs';
import { membresias } from './auth.mjs';
import { crearRespaldo, verificarRespaldo, rutaRespaldo } from './backup.mjs';
import { importar, catalogosPlantilla } from './importar.mjs';
import { rutasComunidad } from './comunidad.mjs';

const FILES_DIR = join(DATA_DIR, 'archivos');
mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });

// ---------- Permisos ----------
const PERMS = {
  ver: ['admin', 'contador', 'comite'],
  capturar: ['admin', 'contador'],
  aprobar: ['admin', 'comite'],
  cancelar: ['admin'],
  cerrar: ['admin'],
  config: ['admin'],
  usuarios: ['admin'],
  auditoria: ['admin', 'comite'],
  comunicar: ['admin', 'comite'],   // avisos, documentos, encuestas
  residente: ['residente'],
};
function rolEn(ctx, cid) {
  if (ctx.user.superadmin) return 'admin';
  return ctx.db.prepare('SELECT rol FROM membresias WHERE usuario_id = ? AND condominio_id = ?').get(ctx.user.id, cid)?.rol || null;
}
function exigir(ctx, perm) {
  if (!PERMS[perm].includes(ctx.rol)) fail(403, 'No tiene permiso para esta operación.');
}
// Sin membresía el condominio "no existe" para el usuario (no se revela su existencia).
export function resolverCondominio(ctx, perm) {
  if (!/^\d+$/.test(ctx.params.cid)) fail(400, 'Condominio inválido.');
  ctx.cid = +ctx.params.cid;
  ctx.rol = rolEn(ctx, ctx.cid);
  if (!ctx.rol || !ctx.db.prepare('SELECT 1 FROM condominios WHERE id = ? AND activo = 1').get(ctx.cid)) fail(404, 'Condominio no encontrado');
  if (perm) exigir(ctx, perm);
}

// Escritura auditada: la acción y su bitácora se confirman juntas o no se confirma nada.
function escribir(ctx, accion, entidad, fn) {
  return tx(ctx.db, () => {
    const r = fn();
    const id = typeof r === 'number' ? r : r?.id ?? null;
    audit(ctx.db, { usuario_id: ctx.user.id, condominio_id: ctx.cid, ip: ctx.ip, accion, entidad, entidad_id: id, detalle: ctx.auditDetalle ?? sinSecretos(ctx.body) });
    return r;
  });
}
const sinSecretos = b => {
  if (!b || typeof b !== 'object') return null;
  const o = { ...b }; for (const k of ['password', 'nueva', 'actual', 'contenido', 'base64', 'filas']) if (k in o) o[k] = Array.isArray(o[k]) ? `[${o[k].length}]` : '[omitido]';
  return o;
};

const q = (ctx, k, def = null) => ctx.query.get(k) ?? def;
const qPeriodo = (ctx, k, def) => { const p = q(ctx, k, def); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) fail(400, `Periodo «${k}» inválido.`); return p; };
const qFecha = (ctx, k, def) => { const p = q(ctx, k, def); if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) fail(400, `Fecha «${k}» inválida.`); return p; };
const qInt = (ctx, k, def = null) => { const s = q(ctx, k); if (s == null || s === '') return def; if (!/^\d+$/.test(s)) fail(400, `«${k}» inválido.`); return +s; };
const idParam = (ctx, k = 'id') => { const s = ctx.params[k]; if (!/^\d+$/.test(s)) fail(400, 'Identificador inválido.'); return +s; };

function unidadesDeResidente(ctx) {
  const m = ctx.db.prepare('SELECT persona_id FROM membresias WHERE usuario_id = ? AND condominio_id = ?').get(ctx.user.id, ctx.cid);
  if (!m?.persona_id) return [];
  return ctx.db.prepare('SELECT u.* FROM unidad_personas up JOIN unidades u ON u.id = up.unidad_id WHERE up.persona_id = ? AND u.condominio_id = ? GROUP BY u.id').all(m.persona_id, ctx.cid);
}
const unidadDelCondo = (ctx, uid) => ctx.db.prepare('SELECT * FROM unidades WHERE id = ? AND condominio_id = ?').get(uid, ctx.cid) || fail(404, 'Unidad no encontrada');

// ---------- Archivos (comprobantes, facturas) ----------
const FIRMAS = [
  ['application/pdf', b => b.subarray(0, 5).toString() === '%PDF-'],
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['application/xml', b => /^﻿?\s*<(\?xml|cfdi:Comprobante)/.test(b.subarray(0, 200).toString('utf8'))],
];
function guardarArchivo(ctx, nombre, base64) {
  if (typeof base64 !== 'string' || base64.length > 7_000_000) fail(413, 'El archivo excede 5 MB.');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) fail(400, 'Archivo vacío.');
  const tipo = FIRMAS.find(([, test]) => test(buf));
  if (!tipo) fail(415, 'Solo se aceptan PDF, PNG, JPG o XML de CFDI.');
  const h = sha256(buf);
  const prev = ctx.db.prepare('SELECT id FROM archivos WHERE condominio_id = ? AND sha256 = ?').get(ctx.cid, h);
  if (prev) return prev.id; // el mismo archivo no se almacena dos veces
  const path = join(FILES_DIR, h);
  if (!existsSync(path)) writeFileSync(path, buf, { mode: 0o600 });
  const limpio = String(nombre || 'archivo').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120);
  return Number(ctx.db.prepare('INSERT INTO archivos (condominio_id, sha256, nombre, mime, bytes, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ctx.cid, h, limpio, tipo[0], buf.length, ctx.user.id, Date.now()).lastInsertRowid);
}

export function leerCfdi(xml) {
  const attr = (tag, a) => {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?\\s${a}="([^"]*)"`, 'i'));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : null;
  };
  const cents = s => s == null ? null : Math.round(parseFloat(s) * 100);
  const uuid = attr('TimbreFiscalDigital', 'UUID');
  if (!uuid) fail(400, 'El XML no contiene un timbre fiscal (UUID).');
  return {
    uuid: uuid.toUpperCase(), fecha: (attr('Comprobante', 'Fecha') || '').slice(0, 10) || null,
    serie: attr('Comprobante', 'Serie'), folio: attr('Comprobante', 'Folio'),
    subtotal_cents: cents(attr('Comprobante', 'SubTotal')), total_cents: cents(attr('Comprobante', 'Total')),
    iva_cents: cents(attr('Impuestos', 'TotalImpuestosTrasladados')) || 0, retenciones_cents: cents(attr('Impuestos', 'TotalImpuestosRetenidos')) || 0,
    emisor_rfc: attr('Emisor', 'Rfc'), emisor_nombre: attr('Emisor', 'Nombre'), receptor_rfc: attr('Receptor', 'Rfc'),
  };
}

// ---------- CSV seguro (neutraliza inyección de fórmulas en Excel) ----------
function csv(rows, cols) {
  const cell = x => {
    if (x == null) return '';
    let s = String(x);
    if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\r\n');
}
const pesos = c => (c / 100).toFixed(2);

// ---------- Rutas ----------
const C = '/api/c/:cid';
const pagoBody = {
  unidad_id: 'int|min1', fecha: 'date', monto_cents: 'cents', metodo: 'enum|transferencia|deposito|efectivo|tarjeta|cheque|domiciliacion',
  referencia: 'str|opt|max60', cuenta_banco_id: 'int|opt', comprobante_id: 'int|opt', notas: 'str|opt|max300', idem_key: 'key', confirmar_duplicado: 'bool|opt',
};

export const apiRoutes = [
  // ===== Global =====
  ['GET', '/api/consolidado', {}, ctx => {
    const periodo = qPeriodo(ctx, 'periodo', periodoActual());
    return membresias(ctx.db, ctx.user).filter(c => PERMS.ver.includes(c.rol)).map(c => {
      const t = R.tablero(ctx.db, c.id, periodo);
      return { id: c.id, nombre: c.nombre, ciudad: c.ciudad, ...t.kpis, pendientes: t.pendientes, serie: t.serie };
    });
  }],
  ['POST', '/api/condominios', {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador crea condominios.');
    const b = v(ctx.body, { nombre: 'str|max120', razon_social: 'str|opt|max160', rfc: 'rfc|opt', direccion: 'str|opt|max250', ciudad: 'str|opt|max80' });
    return tx(ctx.db, () => {
      const id = F.crearCondominio(ctx.db, b, ctx.user);
      audit(ctx.db, { usuario_id: ctx.user.id, condominio_id: id, ip: ctx.ip, accion: 'condominio_creado', entidad: 'condominio', entidad_id: id, detalle: b });
      return { id };
    });
  }],
  ['GET', '/api/admin/respaldos', {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador gestiona respaldos.');
    return ctx.db.prepare('SELECT * FROM respaldos ORDER BY id DESC LIMIT 100').all();
  }],
  ['POST', '/api/admin/respaldos', {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador gestiona respaldos.');
    const r = crearRespaldo(ctx.db, 'manual');
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'respaldo_manual', detalle: r });
    return r;
  }],
  ['POST', '/api/admin/respaldos/:f/verificar', {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador gestiona respaldos.');
    const r = verificarRespaldo(ctx.params.f);
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'respaldo_verificado', detalle: { archivo: ctx.params.f, ok: r.ok } });
    return r;
  }],
  ['GET', '/api/admin/respaldos/:f', {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador gestiona respaldos.');
    const p = rutaRespaldo(ctx.params.f) || fail(404, 'Respaldo no encontrado');
    audit(ctx.db, { usuario_id: ctx.user.id, ip: ctx.ip, accion: 'respaldo_descargado', detalle: { archivo: ctx.params.f } });
    return { __file: { path: p, name: ctx.params.f, mime: 'application/octet-stream' } };
  }],
  ['GET', '/api/admin/auditoria/verificar', {}, ctx => {
    if (!ctx.user.superadmin && !membresias(ctx.db, ctx.user).some(m => PERMS.auditoria.includes(m.rol))) fail(403, 'Sin permiso.');
    return verifyAuditChain(ctx.db);
  }],

  // ===== Tablero y configuración =====
  ['GET', `${C}/tablero`, { perm: 'ver' }, ctx => R.tablero(ctx.db, ctx.cid, qPeriodo(ctx, 'periodo', periodoActual()))],
  ['GET', `${C}/config`, { perm: 'ver' }, ctx => F.condo(ctx.db, ctx.cid)],
  ['PUT', `${C}/config`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max120', razon_social: 'str|opt|max160', rfc: 'rfc|opt', direccion: 'str|opt|max250', ciudad: 'str|opt|max80',
      dia_vencimiento: 'int|min1|max28', dias_gracia: 'int|min0|max60', tasa_recargo_bp: 'int|min0|max2000', pct_reserva_bp: 'int|min0|max5000', umbral_aprobacion_cents: 'cents|zero',
      pronto_pago_bp: 'int|min0|max5000|opt', pronto_pago_dia: 'int|min0|max28|opt' });
    if ((b.pronto_pago_bp > 0) !== (b.pronto_pago_dia > 0) && (b.pronto_pago_bp || b.pronto_pago_dia)) fail(400, 'Para el descuento por pronto pago indique el porcentaje y el día límite.');
    return escribir(ctx, 'config_actualizada', 'condominio', () => {
      ctx.db.prepare(`UPDATE condominios SET nombre=?, razon_social=?, rfc=?, direccion=?, ciudad=?, dia_vencimiento=?, dias_gracia=?, tasa_recargo_bp=?, pct_reserva_bp=?, umbral_aprobacion_cents=?, pronto_pago_bp=?, pronto_pago_dia=? WHERE id=?`)
        .run(b.nombre, b.razon_social, b.rfc, b.direccion, b.ciudad, b.dia_vencimiento, b.dias_gracia, b.tasa_recargo_bp, b.pct_reserva_bp, b.umbral_aprobacion_cents, b.pronto_pago_bp ?? 0, b.pronto_pago_dia ?? 0, ctx.cid);
      return ctx.cid;
    });
  }],

  // ===== Unidades y residentes =====
  ['GET', `${C}/unidades`, { perm: 'ver' }, ctx => R.carteraUnidades(ctx.db, ctx.cid)],
  ['GET', `${C}/unidades/:id`, { perm: 'ver' }, ctx => {
    const u = unidadDelCondo(ctx, idParam(ctx));
    return {
      unidad: u,
      personas: ctx.db.prepare('SELECT up.id AS vinculo_id, up.rol, p.* FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? ORDER BY up.rol').all(u.id),
      cartera: R.carteraUnidades(ctx.db, ctx.cid).find(x => x.id === u.id),
      pagos: ctx.db.prepare('SELECT * FROM pagos WHERE unidad_id = ? ORDER BY fecha DESC, id DESC LIMIT 24').all(u.id),
      gestiones: ctx.db.prepare('SELECT g.*, us.nombre AS autor FROM gestiones g LEFT JOIN usuarios us ON us.id = g.created_by WHERE g.unidad_id = ? ORDER BY g.created_at DESC LIMIT 30').all(u.id),
      convenio: ctx.db.prepare("SELECT * FROM convenios WHERE unidad_id = ? AND estado = 'vigente'").get(u.id) || null,
    };
  }],
  ['POST', `${C}/unidades`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { clave: 'str|max20', torre: 'str|opt|max30', tipo: 'enum|departamento|casa|local|oficina|bodega|estacionamiento', m2: 'int|opt|min0|max100000',
      indiviso_ppm: 'int|min0|max1000000', cuota_cents: 'cents|zero', estado: 'enum|ocupada|vacante|renta', notas: 'str|opt|max300' });
    return escribir(ctx, 'unidad_creada', 'unidad', () => {
      if (ctx.db.prepare('SELECT 1 FROM unidades WHERE condominio_id = ? AND clave = ?').get(ctx.cid, b.clave)) fail(409, 'Ya existe una unidad con esa clave.', 'DUPLICADO');
      const ref = referenciaPago(ctx.db, ctx.cid, b.clave);
      return Number(ctx.db.prepare('INSERT INTO unidades (condominio_id, clave, torre, tipo, m2, indiviso_ppm, cuota_cents, referencia, estado, notas, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(ctx.cid, b.clave, b.torre, b.tipo, b.m2, b.indiviso_ppm, b.cuota_cents, ref, b.estado, b.notas, Date.now()).lastInsertRowid);
    });
  }],
  ['PUT', `${C}/unidades/:id`, { perm: 'config' }, ctx => {
    const u = unidadDelCondo(ctx, idParam(ctx));
    const b = v(ctx.body, { torre: 'str|opt|max30', tipo: 'enum|departamento|casa|local|oficina|bodega|estacionamiento', m2: 'int|opt|min0|max100000',
      indiviso_ppm: 'int|min0|max1000000', cuota_cents: 'cents|zero', estado: 'enum|ocupada|vacante|renta', notas: 'str|opt|max300', activo: 'bool' });
    ctx.auditDetalle = { antes: { cuota_cents: u.cuota_cents, indiviso_ppm: u.indiviso_ppm, activo: u.activo }, despues: b };
    return escribir(ctx, 'unidad_actualizada', 'unidad', () => {
      ctx.db.prepare('UPDATE unidades SET torre=?, tipo=?, m2=?, indiviso_ppm=?, cuota_cents=?, estado=?, notas=?, activo=? WHERE id=?')
        .run(b.torre, b.tipo, b.m2, b.indiviso_ppm, b.cuota_cents, b.estado, b.notas, b.activo ? 1 : 0, u.id);
      return u.id;
    });
  }],
  ['GET', `${C}/personas`, { perm: 'ver' }, ctx => ctx.db.prepare(`SELECT p.*, (SELECT GROUP_CONCAT(u.clave || ':' || up.rol, ', ') FROM unidad_personas up JOIN unidades u ON u.id = up.unidad_id WHERE up.persona_id = p.id) AS unidades
    FROM personas p WHERE p.condominio_id = ? AND p.activo = 1 ORDER BY p.nombre`).all(ctx.cid)],
  ['POST', `${C}/personas`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max120', email: 'email|opt', telefono: 'str|opt|max30', rfc: 'rfc|opt', notas: 'str|opt|max300', unidad_id: 'int|opt', rol: 'enum|propietario|inquilino|responsable|opt' });
    return escribir(ctx, 'persona_creada', 'persona', () => {
      if (b.email && ctx.db.prepare('SELECT 1 FROM personas WHERE condominio_id = ? AND email = ? COLLATE NOCASE AND activo = 1').get(ctx.cid, b.email)) fail(409, 'Ya existe una persona con ese correo.', 'DUPLICADO');
      const id = Number(ctx.db.prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, rfc, notas, created_at) VALUES (?,?,?,?,?,?,?)').run(ctx.cid, b.nombre, b.email, b.telefono, b.rfc, b.notas, Date.now()).lastInsertRowid);
      if (b.unidad_id) { unidadDelCondo(ctx, b.unidad_id); ctx.db.prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)').run(b.unidad_id, id, b.rol || 'propietario'); }
      return id;
    });
  }],
  ['PUT', `${C}/personas/:id`, { perm: 'capturar' }, ctx => {
    const id = idParam(ctx);
    ctx.db.prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?').get(id, ctx.cid) || fail(404, 'Persona no encontrada');
    const b = v(ctx.body, { nombre: 'str|max120', email: 'email|opt', telefono: 'str|opt|max30', rfc: 'rfc|opt', notas: 'str|opt|max300' });
    return escribir(ctx, 'persona_actualizada', 'persona', () => { ctx.db.prepare('UPDATE personas SET nombre=?, email=?, telefono=?, rfc=?, notas=? WHERE id=?').run(b.nombre, b.email, b.telefono, b.rfc, b.notas, id); return id; });
  }],
  ['POST', `${C}/unidades/:id/personas`, { perm: 'capturar' }, ctx => {
    const u = unidadDelCondo(ctx, idParam(ctx));
    const b = v(ctx.body, { persona_id: 'int|min1', rol: 'enum|propietario|inquilino|responsable' });
    ctx.db.prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?').get(b.persona_id, ctx.cid) || fail(404, 'Persona no encontrada');
    return escribir(ctx, 'persona_vinculada', 'unidad', () => {
      if (ctx.db.prepare('SELECT 1 FROM unidad_personas WHERE unidad_id = ? AND persona_id = ? AND rol = ?').get(u.id, b.persona_id, b.rol)) fail(409, 'La persona ya está vinculada con ese rol.');
      ctx.db.prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)').run(u.id, b.persona_id, b.rol); return u.id;
    });
  }],
  ['DELETE', `${C}/unidades/:id/personas/:vid`, { perm: 'capturar' }, ctx => {
    const u = unidadDelCondo(ctx, idParam(ctx));
    return escribir(ctx, 'persona_desvinculada', 'unidad', () => { ctx.db.prepare('DELETE FROM unidad_personas WHERE id = ? AND unidad_id = ?').run(idParam(ctx, 'vid'), u.id); return u.id; });
  }],

  // ===== Estados de cuenta y cobranza =====
  ['GET', `${C}/estado-cuenta/:id`, {}, ctx => {
    const uid = idParam(ctx);
    if (ctx.rol === 'residente') { if (!unidadesDeResidente(ctx).some(u => u.id === uid)) fail(404, 'Unidad no encontrada'); }
    else exigir(ctx, 'ver');
    const u = unidadDelCondo(ctx, uid);
    const hasta = qFecha(ctx, 'hasta', hoy());
    const desde = qFecha(ctx, 'desde', `${addMonths(periodoDe(hasta), -5)}-01`);
    const c = F.condo(ctx.db, ctx.cid);
    const personas = ctx.db.prepare("SELECT p.nombre, p.email, up.rol FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ?").all(u.id);
    const bancos = ctx.db.prepare("SELECT banco, nombre, clabe_mask FROM cuentas_banco WHERE condominio_id = ? AND activo = 1 AND fondo = 'operacion'").all(ctx.cid);
    return { condominio: { nombre: c.nombre, razon_social: c.razon_social, rfc: c.rfc, direccion: c.direccion }, unidad: u, personas, bancos, desde, hasta, ...R.estadoCuenta(ctx.db, ctx.cid, u.id, desde, hasta) };
  }],
  ['GET', `${C}/estados-cuenta`, { perm: 'ver' }, ctx => {
    const hasta = qFecha(ctx, 'hasta', hoy()); const desde = qFecha(ctx, 'desde', `${periodoDe(hasta)}-01`);
    const c = F.condo(ctx.db, ctx.cid);
    return { condominio: c, desde, hasta, unidades: ctx.db.prepare('SELECT id, clave, torre, referencia FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY torre, clave').all(ctx.cid)
      .map(u => ({ unidad: u, propietario: ctx.db.prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'").get(u.id).n, ...R.estadoCuenta(ctx.db, ctx.cid, u.id, desde, hasta) })) };
  }],
  ['GET', `${C}/cargos`, { perm: 'ver' }, ctx => {
    const where = ['c.condominio_id = ?']; const args = [ctx.cid];
    if (q(ctx, 'unidad')) { where.push('c.unidad_id = ?'); args.push(qInt(ctx, 'unidad')); }
    if (q(ctx, 'periodo')) { where.push('c.periodo = ?'); args.push(qPeriodo(ctx, 'periodo')); }
    if (q(ctx, 'tipo')) { where.push('c.tipo = ?'); args.push(q(ctx, 'tipo')); }
    return ctx.db.prepare(`SELECT c.*, u.clave, c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0) AS saldo_cents
      FROM cargos c JOIN unidades u ON u.id = c.unidad_id WHERE ${where.join(' AND ')} ORDER BY c.fecha DESC, u.clave LIMIT 2000`).all(...args);
  }],
  ['GET', `${C}/emisiones`, { perm: 'ver' }, ctx => ctx.db.prepare(`SELECT p.id, p.fecha, p.periodo, p.concepto, p.origen, p.total_cents, p.tipo, p.folio, COUNT(c.id) AS cargos, us.nombre AS autor
    FROM polizas p JOIN cargos c ON c.poliza_id = p.id LEFT JOIN usuarios us ON us.id = p.created_by WHERE p.condominio_id = ? AND p.origen IN ('emision','extraordinaria','recargos')
    GROUP BY p.id ORDER BY p.fecha DESC, p.id DESC LIMIT 60`).all(ctx.cid)],
  ['POST', `${C}/cobranza/emitir`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { periodo: 'periodo' });
    return escribir(ctx, 'cuotas_emitidas', 'emision', () => F.emitirCuotas(ctx.db, ctx.cid, b.periodo, ctx.user));
  }],
  ['POST', `${C}/cobranza/extraordinaria`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { concepto: 'str|max120', total_cents: 'cents', metodo: 'enum|indiviso|igual', destino: 'enum|operacion|reserva|fondo', fondo_id: 'int|opt', fecha: 'date', vencimiento: 'date', unidades: 'arr|opt' });
    if (b.destino === 'fondo' && !b.fondo_id) fail(400, 'Seleccione el fondo que recibirá la cuota.');
    return escribir(ctx, 'extraordinaria_emitida', 'emision', () => F.emitirExtraordinaria(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/cobranza/cargo`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { unidad_id: 'int|min1', tipo: 'enum|extraordinaria|multa|otro', concepto: 'str|max120', monto_cents: 'cents', fecha: 'date', vencimiento: 'date|opt' });
    return escribir(ctx, 'cargo_individual', 'cargo', () => F.cargoIndividual(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/cobranza/recargos`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { periodo: 'periodo' });
    return escribir(ctx, 'recargos_calculados', 'emision', () => F.calcularRecargos(ctx.db, ctx.cid, b.periodo, ctx.user));
  }],
  ['POST', `${C}/cargos/:id/bonificar`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { monto_cents: 'cents', motivo: 'str|max200' });
    return escribir(ctx, 'cargo_bonificado', 'cargo', () => ({ id: idParam(ctx), poliza: F.bonificar(ctx.db, ctx.cid, idParam(ctx), b.monto_cents, b.motivo, ctx.user) }));
  }],
  ['POST', `${C}/cargos/:id/cancelar`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { motivo: 'str|max200' });
    return escribir(ctx, 'cargo_cancelado', 'cargo', () => ({ id: idParam(ctx), poliza: F.cancelarCargo(ctx.db, ctx.cid, idParam(ctx), b.motivo, ctx.user) }));
  }],

  // ===== Pagos =====
  ['GET', `${C}/pagos`, { perm: 'ver' }, ctx => {
    const where = ['p.condominio_id = ?']; const args = [ctx.cid];
    if (q(ctx, 'estado')) { where.push('p.estado = ?'); args.push(q(ctx, 'estado')); }
    if (q(ctx, 'unidad')) { where.push('p.unidad_id = ?'); args.push(qInt(ctx, 'unidad')); }
    if (q(ctx, 'desde')) { where.push('p.fecha >= ?'); args.push(qFecha(ctx, 'desde')); }
    if (q(ctx, 'hasta')) { where.push('p.fecha <= ?'); args.push(qFecha(ctx, 'hasta')); }
    return ctx.db.prepare(`SELECT p.*, u.clave, b.banco, b.nombre AS cuenta_nombre, a.nombre AS comprobante_nombre, us.nombre AS capturo,
      (SELECT COUNT(*) FROM banco_movs bm WHERE bm.conciliado_tipo = 'pago' AND bm.conciliado_id = p.id) AS conciliado
      FROM pagos p JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id LEFT JOIN archivos a ON a.id = p.comprobante_id LEFT JOIN usuarios us ON us.id = p.created_by
      WHERE ${where.join(' AND ')} ORDER BY p.fecha DESC, p.id DESC LIMIT 1000`).all(...args);
  }],
  ['POST', `${C}/pagos`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, pagoBody);
    return escribir(ctx, 'pago_registrado', 'pago', () => F.registrarPago(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/pagos/:id/validar`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { aceptar: 'bool', motivo: 'str|opt|max200', cuenta_banco_id: 'int|opt' });
    return escribir(ctx, b.aceptar ? 'pago_validado' : 'pago_rechazado', 'pago', () => ({ id: idParam(ctx), ...F.validarPago(ctx.db, ctx.cid, idParam(ctx), b, ctx.user) }));
  }],
  ['POST', `${C}/pagos/:id/cancelar`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { motivo: 'str|max200' });
    return escribir(ctx, 'pago_cancelado', 'pago', () => ({ id: idParam(ctx), ...F.cancelarPago(ctx.db, ctx.cid, idParam(ctx), b.motivo, ctx.user) }));
  }],
  ['GET', `${C}/pagos/:id/recibo`, {}, ctx => {
    const p = ctx.db.prepare("SELECT p.*, u.clave, u.referencia AS ref_unidad, b.banco FROM pagos p JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id WHERE p.id = ? AND p.condominio_id = ?").get(idParam(ctx), ctx.cid) || fail(404, 'Pago no encontrado');
    if (ctx.rol === 'residente') { if (!unidadesDeResidente(ctx).some(u => u.id === p.unidad_id)) fail(404, 'Pago no encontrado'); } else exigir(ctx, 'ver');
    if (p.estado !== 'aplicado' && p.estado !== 'cancelado') fail(409, 'El pago aún no tiene recibo.');
    const apl = ctx.db.prepare('SELECT a.monto_cents, a.revertida, c.concepto, c.periodo FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.pago_id = ? ORDER BY a.id').all(p.id);
    const c = F.condo(ctx.db, ctx.cid);
    const propietario = ctx.db.prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'").get(p.unidad_id).n;
    return { condominio: { nombre: c.nombre, razon_social: c.razon_social, rfc: c.rfc, direccion: c.direccion }, pago: p, propietario, aplicaciones: apl,
      sello: sha256(`${ctx.cid}|${p.id}|${p.folio}|${p.monto_cents}|${p.fecha}|${p.poliza_id}`).slice(0, 24).toUpperCase() };
  }],

  // ===== Morosidad =====
  ['GET', `${C}/morosidad`, { perm: 'ver' }, ctx => {
    const corte = qFecha(ctx, 'corte', hoy());
    const rows = R.carteraUnidades(ctx.db, ctx.cid, corte);
    return { corte, resumen: R.resumenCartera(rows), unidades: rows };
  }],
  ['POST', `${C}/gestiones`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { unidad_id: 'int|min1', tipo: 'enum|llamada|correo|whatsapp|visita|carta|promesa|aviso_legal', nota: 'str|max500', promesa_fecha: 'date|opt', promesa_cents: 'cents|opt' });
    unidadDelCondo(ctx, b.unidad_id);
    return escribir(ctx, 'gestion_cobranza', 'unidad', () => Number(ctx.db.prepare('INSERT INTO gestiones (condominio_id, unidad_id, tipo, nota, promesa_fecha, promesa_cents, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(ctx.cid, b.unidad_id, b.tipo, b.nota, b.promesa_fecha, b.promesa_cents, ctx.user.id, Date.now()).lastInsertRowid));
  }],
  ['GET', `${C}/constancia/:id`, { perm: 'ver' }, ctx => {
    const u = unidadDelCondo(ctx, idParam(ctx));
    const cart = R.carteraUnidades(ctx.db, ctx.cid).find(x => x.id === u.id);
    const c = F.condo(ctx.db, ctx.cid);
    const propietario = ctx.db.prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'").get(u.id).n;
    const detalle = F.cargosAbiertos(ctx.db, u.id);
    const folio = `CA-${ctx.cid}-${u.id}-${Date.now().toString(36).toUpperCase()}`;
    audit(ctx.db, { usuario_id: ctx.user.id, condominio_id: ctx.cid, ip: ctx.ip, accion: 'constancia_emitida', entidad: 'unidad', entidad_id: u.id, detalle: { folio, adeudo: cart.adeudo } });
    return { tipo: cart.adeudo > 0 ? 'adeudo' : 'no_adeudo', folio, fecha: hoy(), condominio: c, unidad: u, propietario, adeudo: cart.adeudo, vencido: cart.vencido, saldo_favor: cart.saldo_favor, detalle,
      sello: sha256(`${folio}|${u.id}|${cart.adeudo}|${hoy()}`).slice(0, 24).toUpperCase() };
  }],
  ['GET', `${C}/convenios`, { perm: 'ver' }, ctx => ctx.db.prepare('SELECT cv.*, u.clave FROM convenios cv JOIN unidades u ON u.id = cv.unidad_id WHERE cv.condominio_id = ? ORDER BY cv.created_at DESC').all(ctx.cid).map(cv => {
    const est = cv.estado === 'vigente' ? F.estadoConvenio(ctx.db, cv) : null;
    if (est && est.restante <= 0) { ctx.db.prepare("UPDATE convenios SET estado = 'cumplido' WHERE id = ?").run(cv.id); cv.estado = 'cumplido'; }
    return { ...cv, ...(est || {}), parcialidades_det: ctx.db.prepare('SELECT * FROM convenio_parcialidades WHERE convenio_id = ? ORDER BY numero').all(cv.id) };
  })],
  ['POST', `${C}/convenios`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { unidad_id: 'int|min1', parcialidades: 'int|min1|max60', fecha: 'date', condonar_recargos: 'bool', notas: 'str|opt|max300' });
    if (b.condonar_recargos) exigir(ctx, 'cancelar');
    return escribir(ctx, 'convenio_creado', 'convenio', () => F.crearConvenio(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/convenios/:id/cancelar`, { perm: 'cancelar' }, ctx => escribir(ctx, 'convenio_cancelado', 'convenio', () => {
    const r = ctx.db.prepare("UPDATE convenios SET estado = 'cancelado' WHERE id = ? AND condominio_id = ? AND estado = 'vigente'").run(idParam(ctx), ctx.cid);
    if (!r.changes) fail(404, 'Convenio vigente no encontrado'); return idParam(ctx);
  })],

  // ===== Egresos y proveedores =====
  ['GET', `${C}/proveedores`, { perm: 'ver' }, ctx => ctx.db.prepare(`SELECT pr.*, (SELECT COALESCE(SUM(total_cents), 0) FROM egresos e WHERE e.proveedor_id = pr.id AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 4) = ?) AS ejercido_anio
    FROM proveedores pr WHERE pr.condominio_id = ? ORDER BY pr.nombre`).all(hoy().slice(0, 4), ctx.cid)],
  ['POST', `${C}/proveedores`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max160', rfc: 'rfc|opt', giro: 'str|opt|max80', email: 'email|opt', telefono: 'str|opt|max30', clabe: 'str|opt|max18' });
    if (b.clabe && !/^\d{18}$/.test(b.clabe)) fail(400, 'La CLABE debe tener 18 dígitos.');
    return escribir(ctx, 'proveedor_creado', 'proveedor', () => {
      if (b.rfc && ctx.db.prepare('SELECT 1 FROM proveedores WHERE condominio_id = ? AND rfc = ?').get(ctx.cid, b.rfc)) fail(409, 'Ya existe un proveedor con ese RFC.', 'DUPLICADO');
      return Number(ctx.db.prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, email, telefono, clabe_mask, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(ctx.cid, b.nombre, b.rfc, b.giro, b.email, b.telefono, mask(b.clabe), Date.now()).lastInsertRowid);
    });
  }],
  ['PUT', `${C}/proveedores/:id`, { perm: 'capturar' }, ctx => {
    const id = idParam(ctx);
    ctx.db.prepare('SELECT 1 FROM proveedores WHERE id = ? AND condominio_id = ?').get(id, ctx.cid) || fail(404, 'Proveedor no encontrado');
    const b = v(ctx.body, { nombre: 'str|max160', giro: 'str|opt|max80', email: 'email|opt', telefono: 'str|opt|max30', activo: 'bool' });
    return escribir(ctx, 'proveedor_actualizado', 'proveedor', () => { ctx.db.prepare('UPDATE proveedores SET nombre=?, giro=?, email=?, telefono=?, activo=? WHERE id=?').run(b.nombre, b.giro, b.email, b.telefono, b.activo ? 1 : 0, id); return id; });
  }],
  ['GET', `${C}/egresos`, { perm: 'ver' }, ctx => {
    const where = ['e.condominio_id = ?']; const args = [ctx.cid];
    if (q(ctx, 'estado')) { where.push('e.estado = ?'); args.push(q(ctx, 'estado')); }
    if (q(ctx, 'desde')) { where.push('e.fecha >= ?'); args.push(qFecha(ctx, 'desde')); }
    if (q(ctx, 'hasta')) { where.push('e.fecha <= ?'); args.push(qFecha(ctx, 'hasta')); }
    return ctx.db.prepare(`SELECT e.*, pr.nombre AS proveedor, k.codigo AS partida_codigo, k.nombre AS partida, uc.nombre AS capturo, ua.nombre AS aprobo, a.nombre AS comprobante_nombre, (SELECT nombre FROM fondos f WHERE f.id = e.fondo_id) AS fondo_nombre,
      (SELECT COUNT(*) FROM banco_movs bm WHERE bm.conciliado_tipo = 'egreso' AND bm.conciliado_id = e.id) AS conciliado
      FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN usuarios uc ON uc.id = e.created_by LEFT JOIN usuarios ua ON ua.id = e.aprobado_por LEFT JOIN archivos a ON a.id = e.comprobante_id
      WHERE ${where.join(' AND ')} ORDER BY e.fecha DESC, e.id DESC LIMIT 1000`).all(...args);
  }],
  ['POST', `${C}/egresos`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { proveedor_id: 'int|opt', cuenta_id: 'int|min1', fondo: 'enum|operacion|reserva', fondo_id: 'int|opt', fecha: 'date', concepto: 'str|max200', subtotal_cents: 'cents|zero', iva_cents: 'cents|zero',
      retenciones_cents: 'cents|zero', factura_folio: 'str|opt|max40', cfdi_uuid: 'uuid|opt', comprobante_id: 'int|opt', idem_key: 'key' });
    return escribir(ctx, 'egreso_capturado', 'egreso', () => F.crearEgreso(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/egresos/:id/aprobar`, { perm: 'aprobar' }, ctx => {
    const b = v(ctx.body, { aprobar: 'bool', motivo: 'str|opt|max200' });
    return escribir(ctx, b.aprobar ? 'egreso_aprobado' : 'egreso_rechazado', 'egreso', () => ({ id: idParam(ctx), ...F.aprobarEgreso(ctx.db, ctx.cid, idParam(ctx), b.aprobar, b.motivo, ctx.user) }));
  }],
  ['POST', `${C}/egresos/:id/pagar`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { fecha_pago: 'date', metodo: 'enum|transferencia|cheque|efectivo|tarjeta|domiciliacion', cuenta_banco_id: 'int|opt', referencia: 'str|opt|max60' });
    return escribir(ctx, 'egreso_pagado', 'egreso', () => ({ id: idParam(ctx), ...F.pagarEgreso(ctx.db, ctx.cid, idParam(ctx), b, ctx.user) }));
  }],
  ['POST', `${C}/egresos/:id/cancelar`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { motivo: 'str|max200' });
    return escribir(ctx, 'egreso_cancelado', 'egreso', () => ({ id: idParam(ctx), ...F.cancelarEgreso(ctx.db, ctx.cid, idParam(ctx), b.motivo, ctx.user) }));
  }],
  ['POST', `${C}/cfdi/leer`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { base64: 'str|max7000000' });
    const xml = Buffer.from(b.base64, 'base64').toString('utf8');
    if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail(400, 'XML no permitido.');
    const datos = leerCfdi(xml);
    const prov = datos.emisor_rfc ? ctx.db.prepare('SELECT id, nombre FROM proveedores WHERE condominio_id = ? AND rfc = ?').get(ctx.cid, datos.emisor_rfc.toUpperCase()) : null;
    const dup = ctx.db.prepare("SELECT folio FROM egresos WHERE condominio_id = ? AND cfdi_uuid = ? COLLATE NOCASE AND estado NOT IN ('cancelado','rechazado')").get(ctx.cid, datos.uuid);
    return { ...datos, proveedor: prov || null, duplicado: dup ? `E-${dup.folio}` : null };
  }],

  // ===== Archivos =====
  ['POST', `${C}/archivos`, { limite: 8_000_000 }, ctx => {
    if (!PERMS.capturar.includes(ctx.rol) && !PERMS.comunicar.includes(ctx.rol) && ctx.rol !== 'residente') fail(403, 'No tiene permiso para subir archivos.');
    const b = v(ctx.body, { nombre: 'str|max160', base64: 'str|max7000000' });
    return tx(ctx.db, () => ({ id: guardarArchivo(ctx, b.nombre, b.base64) }));
  }],
  ['GET', `${C}/archivos/:id`, {}, ctx => {
    const a = ctx.db.prepare('SELECT * FROM archivos WHERE id = ? AND condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Archivo no encontrado');
    if (ctx.rol === 'residente') {
      const mios = new Set(unidadesDeResidente(ctx).map(u => u.id));
      const ligado = ctx.db.prepare('SELECT unidad_id FROM pagos WHERE comprobante_id = ? AND condominio_id = ?').all(a.id, ctx.cid).some(p => mios.has(p.unidad_id));
      const publicado = ctx.db.prepare("SELECT 1 FROM comunidad WHERE archivo_id = ? AND condominio_id = ? AND publico = 1 AND estado <> 'archivado'").get(a.id, ctx.cid);
      if (!ligado && !publicado && a.created_by !== ctx.user.id) fail(404, 'Archivo no encontrado');
    } else exigir(ctx, 'ver');
    return { __file: { path: join(FILES_DIR, a.sha256), name: a.nombre, mime: a.mime } };
  }],

  // ===== Bancos y conciliación =====
  ['GET', `${C}/bancos`, { perm: 'ver' }, ctx => {
    const sb = R.saldoBancos(ctx.db, ctx.cid);
    return sb.bancos.map(b => ({ ...b,
      saldo_estado: ctx.db.prepare('SELECT COALESCE(SUM(abono_cents - cargo_cents), 0) s FROM banco_movs WHERE cuenta_banco_id = ?').get(b.id).s,
      sin_conciliar: ctx.db.prepare('SELECT COUNT(*) n FROM banco_movs WHERE cuenta_banco_id = ? AND conciliado_tipo IS NULL').get(b.id).n,
      ultimo_mov: ctx.db.prepare('SELECT MAX(fecha) f FROM banco_movs WHERE cuenta_banco_id = ?').get(b.id).f }));
  }],
  ['POST', `${C}/bancos`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max60', banco: 'str|max40', numero: 'str|max20', clabe: 'str|opt|max18', fondo: 'enum|operacion|reserva' });
    if (b.clabe && !/^\d{18}$/.test(b.clabe)) fail(400, 'La CLABE debe tener 18 dígitos.');
    ctx.auditDetalle = { nombre: b.nombre, banco: b.banco, numero: mask(b.numero), fondo: b.fondo };
    return escribir(ctx, 'cuenta_bancaria_creada', 'banco', () => F.crearCuentaBanco(ctx.db, ctx.cid, b));
  }],
  ['GET', `${C}/bancos/:id/movimientos`, { perm: 'ver' }, ctx => {
    const bid = idParam(ctx);
    ctx.db.prepare('SELECT 1 FROM cuentas_banco WHERE id = ? AND condominio_id = ?').get(bid, ctx.cid) || fail(404, 'Cuenta no encontrada');
    const solo = q(ctx, 'estado');
    const movs = ctx.db.prepare(`SELECT * FROM banco_movs WHERE cuenta_banco_id = ? ${solo === 'pendientes' ? 'AND conciliado_tipo IS NULL' : ''} ORDER BY fecha DESC, id DESC LIMIT 500`).all(bid);
    const refUnidad = ctx.db.prepare('SELECT id, clave, referencia FROM unidades WHERE condominio_id = ?').all(ctx.cid);
    return movs.map(m => {
      const texto = `${m.descripcion || ''} ${m.referencia || ''}`.toUpperCase();
      const sugerida = !m.conciliado_tipo && m.abono_cents ? refUnidad.find(u => texto.includes(u.referencia)) || null : null;
      let detalle = null;
      if (m.conciliado_tipo === 'pago') detalle = ctx.db.prepare("SELECT 'R-' || p.folio || ' · ' || u.clave AS t FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.id = ?").get(m.conciliado_id)?.t;
      if (m.conciliado_tipo === 'egreso') detalle = ctx.db.prepare("SELECT 'E-' || folio || ' · ' || concepto AS t FROM egresos WHERE id = ?").get(m.conciliado_id)?.t;
      return { ...m, sugerida, detalle };
    });
  }],
  ['POST', `${C}/bancos/:id/importar`, { perm: 'capturar', limite: 4_000_000 }, ctx => {
    const b = v(ctx.body, { filas: 'arr' });
    const filas = b.filas.map((f, i) => {
      try { return v(f, { fecha: 'date', descripcion: 'str|opt|max200', referencia: 'str|opt|max60', cargo_cents: 'cents|zero', abono_cents: 'cents|zero' }); }
      catch (e) { fail(400, `Fila ${i + 1}: ${e.message}`); }
    }).filter(f => (f.cargo_cents > 0) !== (f.abono_cents > 0));
    if (!filas.length) fail(400, 'El archivo no contiene movimientos válidos.');
    ctx.auditDetalle = { filas: filas.length };
    return escribir(ctx, 'estado_bancario_importado', 'banco', () => ({ id: idParam(ctx), ...F.importarMovimientosBanco(ctx.db, ctx.cid, idParam(ctx), filas, ctx.user) }));
  }],
  ['POST', `${C}/bancos/:id/autoconciliar`, { perm: 'capturar' }, ctx => {
    ctx.db.prepare('SELECT 1 FROM cuentas_banco WHERE id = ? AND condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Cuenta no encontrada');
    return escribir(ctx, 'autoconciliacion', 'banco', () => ({ id: idParam(ctx), conciliados: F.autoConciliar(ctx.db, ctx.cid, idParam(ctx), ctx.user) }));
  }],
  ['GET', `${C}/banco-movs/:id/candidatos`, { perm: 'ver' }, ctx => {
    const m = ctx.db.prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE bm.id = ? AND b.condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Movimiento no encontrado');
    if (m.abono_cents) return ctx.db.prepare(`SELECT p.id, 'pago' AS tipo, p.fecha, p.monto_cents AS monto, 'R-' || p.folio || ' · ' || u.clave || COALESCE(' · ' || p.referencia, '') AS descripcion FROM pagos p JOIN unidades u ON u.id = p.unidad_id
      WHERE p.condominio_id = ? AND p.estado = 'aplicado' AND p.idem_key NOT LIKE 'INI-%' AND p.monto_cents = ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'pago' AND x.conciliado_id = p.id) ORDER BY ABS(julianday(p.fecha) - julianday(?)) LIMIT 10`).all(ctx.cid, m.abono_cents, m.fecha);
    return ctx.db.prepare(`SELECT e.id, 'egreso' AS tipo, e.fecha_pago AS fecha, e.total_cents AS monto, 'E-' || e.folio || ' · ' || e.concepto AS descripcion FROM egresos e
      WHERE e.condominio_id = ? AND e.estado = 'pagado' AND e.total_cents = ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'egreso' AND x.conciliado_id = e.id) ORDER BY ABS(julianday(e.fecha_pago) - julianday(?)) LIMIT 10`).all(ctx.cid, m.cargo_cents, m.fecha);
  }],
  ['POST', `${C}/banco-movs/:id/conciliar`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { tipo: 'enum|pago|egreso|otro|ninguno', id: 'int|opt' });
    return escribir(ctx, b.tipo === 'ninguno' ? 'desconciliacion' : 'conciliacion_manual', 'banco_mov', () => { F.conciliarManual(ctx.db, ctx.cid, idParam(ctx), b.tipo === 'ninguno' ? null : b.tipo, b.id, ctx.user); return idParam(ctx); });
  }],
  ['POST', `${C}/banco-movs/:id/crear-pago`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { unidad_id: 'int|min1' });
    const m = ctx.db.prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco cb ON cb.id = bm.cuenta_banco_id WHERE bm.id = ? AND cb.condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Movimiento no encontrado');
    if (!m.abono_cents || m.conciliado_tipo) fail(409, 'El movimiento no es un depósito pendiente.');
    return escribir(ctx, 'pago_desde_banco', 'pago', () => {
      const r = F.registrarPago(ctx.db, ctx.cid, { unidad_id: b.unidad_id, fecha: m.fecha, monto_cents: m.abono_cents, metodo: 'transferencia', referencia: (m.referencia || m.descripcion || '').slice(0, 60) || null,
        cuenta_banco_id: m.cuenta_banco_id, idem_key: `BANCO-${m.huella.slice(0, 40)}`, confirmar_duplicado: true, notas: 'Identificado desde estado de cuenta bancario' }, ctx.user);
      F.conciliarManual(ctx.db, ctx.cid, m.id, 'pago', r.id, ctx.user);
      return r;
    });
  }],

  // ===== Presupuesto =====
  ['GET', `${C}/presupuestos`, { perm: 'ver' }, ctx => ctx.db.prepare('SELECT p.*, u.nombre AS aprobo, (SELECT COALESCE(SUM(monto_cents), 0) FROM presupuesto_lineas l WHERE l.presupuesto_id = p.id) AS total FROM presupuestos p LEFT JOIN usuarios u ON u.id = p.aprobado_por WHERE p.condominio_id = ? ORDER BY ejercicio DESC, version DESC').all(ctx.cid)],
  ['POST', `${C}/presupuestos`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { ejercicio: 'int|min2000|max2100' });
    return escribir(ctx, 'presupuesto_borrador', 'presupuesto', () => F.nuevaVersionPresupuesto(ctx.db, ctx.cid, b.ejercicio, ctx.user));
  }],
  ['GET', `${C}/presupuestos/:id`, { perm: 'ver' }, ctx => {
    const p = ctx.db.prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Presupuesto no encontrado');
    const cuentas = ctx.db.prepare("SELECT id, codigo, nombre FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo").all(ctx.cid);
    const lineas = ctx.db.prepare('SELECT * FROM presupuesto_lineas WHERE presupuesto_id = ?').all(p.id);
    return { presupuesto: p, cuentas, lineas, vs: R.presupuestoVsReal(ctx.db, ctx.cid, p.ejercicio, p.id), sugerida: F.cuotaSugerida(ctx.db, ctx.cid, p.id) };
  }],
  ['PUT', `${C}/presupuestos/:id/lineas`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { lineas: 'arr' });
    ctx.auditDetalle = { lineas: b.lineas.length };
    return escribir(ctx, 'presupuesto_editado', 'presupuesto', () => { F.guardarLineasPresupuesto(ctx.db, ctx.cid, idParam(ctx), b.lineas); return idParam(ctx); });
  }],
  ['POST', `${C}/presupuestos/:id/aprobar`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { acta: 'str|max200' });
    return escribir(ctx, 'presupuesto_aprobado', 'presupuesto', () => { F.aprobarPresupuesto(ctx.db, ctx.cid, idParam(ctx), b.acta, ctx.user); return idParam(ctx); });
  }],
  ['POST', `${C}/presupuestos/:id/aplicar-cuotas`, { perm: 'config' }, ctx => {
    const p = ctx.db.prepare("SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ? AND estado = 'aprobado'").get(idParam(ctx), ctx.cid) || fail(409, 'Solo se aplican cuotas de un presupuesto aprobado.');
    const s = F.cuotaSugerida(ctx.db, ctx.cid, p.id);
    ctx.auditDetalle = { presupuesto: p.id, cambios: s.unidades.filter(u => u.cuota_cents !== u.sugerida_cents).map(u => [u.clave, u.cuota_cents, u.sugerida_cents]) };
    return escribir(ctx, 'cuotas_actualizadas', 'presupuesto', () => {
      const up = ctx.db.prepare('UPDATE unidades SET cuota_cents = ? WHERE id = ? AND condominio_id = ?');
      for (const u of s.unidades) up.run(u.sugerida_cents, u.id, ctx.cid);
      return { id: p.id, unidades: s.unidades.length };
    });
  }],

  // ===== Fondos, adeudos recurrentes, descuentos =====
  ['GET', `${C}/fondos`, { perm: 'ver' }, ctx => ctx.db.prepare('SELECT f.*, k.codigo FROM fondos f JOIN cuentas k ON k.id = f.cuenta_id WHERE f.condominio_id = ? ORDER BY f.nombre').all(ctx.cid)],
  ['POST', `${C}/fondos`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max80', meta_cents: 'cents|opt', descripcion: 'str|opt|max300' });
    return escribir(ctx, 'fondo_creado', 'fondo', () => F.crearFondo(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['PUT', `${C}/fondos/:id`, { perm: 'config' }, ctx => {
    const id = idParam(ctx);
    ctx.db.prepare('SELECT 1 FROM fondos WHERE id = ? AND condominio_id = ?').get(id, ctx.cid) || fail(404, 'Fondo no encontrado');
    const b = v(ctx.body, { meta_cents: 'cents|opt', descripcion: 'str|opt|max300', activo: 'bool' });
    return escribir(ctx, 'fondo_actualizado', 'fondo', () => { ctx.db.prepare('UPDATE fondos SET meta_cents = ?, descripcion = ?, activo = ? WHERE id = ?').run(b.meta_cents, b.descripcion, b.activo ? 1 : 0, id); return id; });
  }],
  ['GET', `${C}/cargos-recurrentes`, { perm: 'ver' }, ctx => ctx.db.prepare(`SELECT r.*, u.clave, us.nombre AS autor FROM cargos_recurrentes r LEFT JOIN unidades u ON u.id = r.unidad_id LEFT JOIN usuarios us ON us.id = r.created_by
    WHERE r.condominio_id = ? ORDER BY r.activo DESC, r.created_at DESC`).all(ctx.cid)],
  ['POST', `${C}/cargos-recurrentes`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { unidad_id: 'int|opt', tipo: 'enum|extraordinaria|otro|multa', concepto: 'str|max100', monto_cents: 'cents', desde: 'periodo', hasta: 'periodo|opt' });
    return escribir(ctx, 'cargo_recurrente_creado', 'cargo_recurrente', () => F.crearCargoRecurrente(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/cargos-recurrentes/:id/desactivar`, { perm: 'capturar' }, ctx => escribir(ctx, 'cargo_recurrente_desactivado', 'cargo_recurrente', () => {
    const r = ctx.db.prepare('UPDATE cargos_recurrentes SET activo = 0 WHERE id = ? AND condominio_id = ? AND activo = 1').run(idParam(ctx), ctx.cid);
    if (!r.changes) fail(404, 'Cargo recurrente activo no encontrado'); return idParam(ctx);
  })],
  ['GET', `${C}/descuentos`, { perm: 'ver' }, ctx => R.descuentos(ctx.db, ctx.cid, qFecha(ctx, 'desde', `${hoy().slice(0, 4)}-01-01`), qFecha(ctx, 'hasta', hoy()))],
  ['POST', `${C}/descuentos/lote`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { periodo: 'periodo', pct_bp: 'int|min1|max10000', motivo: 'str|max160', unidades: 'arr|opt' });
    return escribir(ctx, 'descuento_lote', 'cargo', () => {
      const filtro = b.unidades?.length ? new Set(b.unidades.map(Number)) : null;
      const cs = ctx.db.prepare("SELECT c.id, c.unidad_id, c.monto_cents FROM cargos c WHERE c.condominio_id = ? AND c.periodo = ? AND c.tipo = 'ordinaria' AND c.cancelado_at IS NULL").all(ctx.cid, b.periodo)
        .filter(c => !filtro || filtro.has(c.unidad_id));
      let n = 0, total = 0;
      for (const c of cs) {
        const saldo = F.cargosAbiertos(ctx.db, c.unidad_id).find(x => x.id === c.id)?.saldo_cents || 0;
        const m = Math.min(saldo, Math.round(c.monto_cents * b.pct_bp / 10000));
        if (m > 0) { F.bonificar(ctx.db, ctx.cid, c.id, m, b.motivo, ctx.user); n++; total += m; }
      }
      if (!n) fail(400, 'No hay cuotas ordinarias con saldo pendiente en ese periodo.');
      return { id: null, cargos: n, total };
    });
  }],

  // ===== Importación desde Excel / CSV =====
  ['GET', `${C}/importar/catalogos`, { perm: 'ver' }, ctx => catalogosPlantilla(ctx.db, ctx.cid)],
  ['POST', `${C}/importar/:tipo`, { limite: 8_000_000 }, ctx => {
    if (!limiteUsuario(ctx, 'importar', 300)) fail(429, 'Demasiadas importaciones en poco tiempo; espere unos minutos.');
    return importar(ctx, ctx.params.tipo, ctx.body, { perms: PERMS, rolPuede: p => PERMS[p].includes(ctx.rol), referenciaPago });
  }],

  // ===== Contabilidad =====
  ['GET', `${C}/cuentas`, { perm: 'ver' }, ctx => ctx.db.prepare('SELECT * FROM cuentas WHERE condominio_id = ? ORDER BY codigo').all(ctx.cid)],
  ['POST', `${C}/cuentas`, { perm: 'config' }, ctx => {
    const b = v(ctx.body, { codigo: 'str|max12', nombre: 'str|max120', tipo: 'enum|activo|pasivo|patrimonio|ingreso|egreso' });
    if (!/^\d{4}(-\d{2})?$/.test(b.codigo)) fail(400, 'Código con formato 0000 o 0000-00.');
    const nat = ['activo', 'egreso'].includes(b.tipo) ? 'D' : 'A';
    return escribir(ctx, 'cuenta_creada', 'cuenta', () => {
      if (ctx.db.prepare('SELECT 1 FROM cuentas WHERE condominio_id = ? AND codigo = ?').get(ctx.cid, b.codigo)) fail(409, 'Ya existe una cuenta con ese código.', 'DUPLICADO');
      return Number(ctx.db.prepare('INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, presupuestable) VALUES (?,?,?,?,?,?)').run(ctx.cid, b.codigo, b.nombre, b.tipo, nat, b.tipo === 'egreso' ? 1 : 0).lastInsertRowid);
    });
  }],
  ['GET', `${C}/polizas`, { perm: 'ver' }, ctx => {
    const where = ['p.condominio_id = ?']; const args = [ctx.cid];
    if (q(ctx, 'periodo')) { where.push('p.periodo = ?'); args.push(qPeriodo(ctx, 'periodo')); }
    if (q(ctx, 'tipo')) { where.push('p.tipo = ?'); args.push(q(ctx, 'tipo')); }
    if (q(ctx, 'q')) { where.push('p.concepto LIKE ?'); args.push('%' + q(ctx, 'q').slice(0, 60).replace(/[%_]/g, '') + '%'); }
    return ctx.db.prepare(`SELECT p.*, u.nombre AS autor FROM polizas p LEFT JOIN usuarios u ON u.id = p.created_by WHERE ${where.join(' AND ')} ORDER BY p.fecha DESC, p.id DESC LIMIT 500`).all(...args);
  }],
  ['GET', `${C}/polizas/:id`, { perm: 'ver' }, ctx => {
    const p = ctx.db.prepare('SELECT p.*, u.nombre AS autor FROM polizas p LEFT JOIN usuarios u ON u.id = p.created_by WHERE p.id = ? AND p.condominio_id = ?').get(idParam(ctx), ctx.cid) || fail(404, 'Póliza no encontrada');
    return { poliza: p, movimientos: ctx.db.prepare('SELECT m.*, k.codigo, k.nombre AS cuenta, un.clave AS unidad FROM movimientos m JOIN cuentas k ON k.id = m.cuenta_id LEFT JOIN unidades un ON un.id = m.unidad_id WHERE m.poliza_id = ? ORDER BY m.id').all(p.id) };
  }],
  ['POST', `${C}/polizas`, { perm: 'capturar' }, ctx => {
    const b = v(ctx.body, { tipo: 'enum|I|E|D', fecha: 'date', concepto: 'str|max200', lineas: 'arr' });
    b.lineas = b.lineas.map(l => v(l, { cuenta: 'int|min1', debe: 'cents|zero', haber: 'cents|zero', concepto: 'str|opt|max120' }));
    return escribir(ctx, 'poliza_manual', 'poliza', () => F.polizaManual(ctx.db, ctx.cid, b, ctx.user));
  }],
  ['POST', `${C}/polizas/:id/revertir`, { perm: 'cancelar' }, ctx => {
    const b = v(ctx.body, { motivo: 'str|max200' });
    return escribir(ctx, 'poliza_revertida', 'poliza', () => F.revertirPoliza(ctx.db, ctx.cid, idParam(ctx), b.motivo, ctx.user));
  }],

  // ===== Reportes =====
  ['GET', `${C}/reportes/resultados`, { perm: 'ver' }, ctx => R.estadoResultados(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', `${hoy().slice(0, 4)}-01`), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/balance`, { perm: 'ver' }, ctx => R.balanceGeneral(ctx.db, ctx.cid, qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/balanza`, { perm: 'ver' }, ctx => R.balanza(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', periodoActual()), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/mayor`, { perm: 'ver' }, ctx => R.libroMayor(ctx.db, ctx.cid, qInt(ctx, 'cuenta') ?? fail(400, 'Indique la cuenta'), qPeriodo(ctx, 'desde', `${hoy().slice(0, 4)}-01`), qPeriodo(ctx, 'hasta', periodoActual())) || fail(404, 'Cuenta no encontrada')],
  ['GET', `${C}/reportes/presupuesto`, { perm: 'ver' }, ctx => R.presupuestoVsReal(ctx.db, ctx.cid, qInt(ctx, 'ejercicio', +hoy().slice(0, 4)))],
  ['GET', `${C}/reportes/flujo`, { perm: 'ver' }, ctx => R.flujoEfectivo(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', `${hoy().slice(0, 4)}-01`), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/fondo-reserva`, { perm: 'ver' }, ctx => R.fondoReserva(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', `${hoy().slice(0, 4)}-01`), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/cobranza`, { perm: 'ver' }, ctx => R.cobranzaMensual(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', addMonths(periodoActual(), -11)), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/fondos`, { perm: 'ver' }, ctx => R.fondos(ctx.db, ctx.cid, qPeriodo(ctx, 'desde', `${hoy().slice(0, 4)}-01`), qPeriodo(ctx, 'hasta', periodoActual()))],
  ['GET', `${C}/reportes/cxp`, { perm: 'ver' }, ctx => R.cuentasPorPagar(ctx.db, ctx.cid, qFecha(ctx, 'corte', hoy()))],
  ['GET', `${C}/reportes/liquidacion`, { perm: 'ver' }, ctx => R.liquidacionAnual(ctx.db, ctx.cid, qInt(ctx, 'ejercicio', +hoy().slice(0, 4)))],
  ['GET', `${C}/reportes/anual`, { perm: 'ver' }, ctx => R.informeAnual(ctx.db, ctx.cid, qInt(ctx, 'ejercicio', +hoy().slice(0, 4)))],
  ['GET', `${C}/integridad`, { perm: 'ver' }, ctx => R.verificarIntegridad(ctx.db, ctx.cid)],

  // ===== Exportaciones CSV =====
  ['GET', `${C}/export/:tipo`, { perm: 'ver' }, ctx => {
    const t = ctx.params.tipo;
    let body;
    if (t === 'cartera.csv') body = csv(R.carteraUnidades(ctx.db, ctx.cid), [['Unidad', r => r.clave], ['Torre', r => r.torre], ['Propietario', r => r.propietario], ['Referencia', r => r.referencia], ['Cuota', r => pesos(r.cuota_cents)],
      ['Por vencer', r => pesos(r.por_vencer)], ['1-30', r => pesos(r.d30)], ['31-60', r => pesos(r.d60)], ['61-90', r => pesos(r.d90)], ['90+', r => pesos(r.d90mas)], ['Vencido', r => pesos(r.vencido)], ['Saldo a favor', r => pesos(r.saldo_favor)], ['Último pago', r => r.ultimo_pago]]);
    else if (t === 'pagos.csv') body = csv(ctx.db.prepare("SELECT p.*, u.clave FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.condominio_id = ? ORDER BY p.fecha").all(ctx.cid),
      [['Recibo', r => r.folio ? `R-${r.folio}` : ''], ['Fecha', r => r.fecha], ['Unidad', r => r.clave], ['Importe', r => pesos(r.monto_cents)], ['Método', r => r.metodo], ['Referencia', r => r.referencia], ['Estado', r => r.estado]]);
    else if (t === 'egresos.csv') body = csv(ctx.db.prepare("SELECT e.*, k.nombre AS partida, pr.nombre AS proveedor FROM egresos e JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN proveedores pr ON pr.id = e.proveedor_id WHERE e.condominio_id = ? ORDER BY e.fecha").all(ctx.cid),
      [['Folio', r => `E-${r.folio}`], ['Fecha', r => r.fecha], ['Proveedor', r => r.proveedor], ['Partida', r => r.partida], ['Fondo', r => r.fondo], ['Concepto', r => r.concepto], ['Subtotal', r => pesos(r.subtotal_cents)], ['IVA', r => pesos(r.iva_cents)], ['Total', r => pesos(r.total_cents)], ['UUID', r => r.cfdi_uuid], ['Estado', r => r.estado]]);
    else if (t === 'polizas.csv') body = csv(ctx.db.prepare("SELECT p.tipo, p.folio, p.fecha, p.concepto AS pc, k.codigo, k.nombre, m.debe_cents, m.haber_cents, m.concepto, u.clave FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id LEFT JOIN unidades u ON u.id = m.unidad_id WHERE p.condominio_id = ? ORDER BY p.fecha, p.id, m.id").all(ctx.cid),
      [['Póliza', r => `${r.tipo}-${r.folio}`], ['Fecha', r => r.fecha], ['Concepto póliza', r => r.pc], ['Cuenta', r => r.codigo], ['Nombre', r => r.nombre], ['Unidad', r => r.clave], ['Debe', r => pesos(r.debe_cents)], ['Haber', r => pesos(r.haber_cents)], ['Concepto', r => r.concepto]]);
    else fail(404, 'Exportación no disponible');
    audit(ctx.db, { usuario_id: ctx.user.id, condominio_id: ctx.cid, ip: ctx.ip, accion: 'exportacion', detalle: { tipo: t } });
    return { __raw: { body, mime: 'text/csv; charset=utf-8', name: t } };
  }],

  // ===== Periodos y cierres =====
  ['GET', `${C}/periodos`, { perm: 'ver' }, ctx => ctx.db.prepare(`SELECT pe.*, u.nombre AS cerro, (SELECT COUNT(*) FROM polizas p WHERE p.condominio_id = pe.condominio_id AND p.periodo = pe.periodo) AS polizas
    FROM periodos pe LEFT JOIN usuarios u ON u.id = pe.cerrado_por WHERE pe.condominio_id = ? ORDER BY pe.periodo DESC`).all(ctx.cid)],
  ['GET', `${C}/periodos/:p/checklist`, { perm: 'ver' }, ctx => { const p = ctx.params.p; if (!/^\d{4}-\d{2}$/.test(p)) fail(400, 'Periodo inválido'); return F.checklistCierre(ctx.db, ctx.cid, p); }],
  ['POST', `${C}/periodos/:p/cerrar`, { perm: 'cerrar' }, ctx => {
    const p = ctx.params.p; if (!/^\d{4}-\d{2}$/.test(p)) fail(400, 'Periodo inválido');
    try { crearRespaldo(ctx.db, `antes de cerrar ${p}`); } catch (e) { fail(500, 'No se pudo crear el respaldo previo al cierre; el cierre se canceló por seguridad.'); }
    return escribir(ctx, 'periodo_cerrado', 'periodo', () => F.cerrarPeriodo(ctx.db, ctx.cid, p, ctx.user));
  }],
  ['POST', `${C}/periodos/:p/reabrir`, {}, ctx => {
    if (!ctx.user.superadmin) fail(403, 'Solo el superadministrador puede reabrir un periodo.');
    const p = ctx.params.p; if (!/^\d{4}-\d{2}$/.test(p)) fail(400, 'Periodo inválido');
    v(ctx.body, { motivo: 'str|max200' });
    return escribir(ctx, 'periodo_reabierto', 'periodo', () => { F.reabrirPeriodo(ctx.db, ctx.cid, p); return null; });
  }],
  ['POST', `${C}/ejercicios/:anio/cerrar`, { perm: 'cerrar' }, ctx => {
    const anio = idParam(ctx, 'anio');
    try { crearRespaldo(ctx.db, `antes de cerrar ejercicio ${anio}`); } catch { fail(500, 'No se pudo crear el respaldo previo; el cierre se canceló por seguridad.'); }
    return escribir(ctx, 'ejercicio_cerrado', 'ejercicio', () => F.cerrarEjercicio(ctx.db, ctx.cid, anio, ctx.user));
  }],

  // ===== Auditoría y usuarios =====
  ['GET', `${C}/auditoria`, { perm: 'auditoria' }, ctx => {
    const lim = Math.min(qInt(ctx, 'limit', 100), 500), off = qInt(ctx, 'offset', 0);
    return ctx.db.prepare('SELECT a.id, a.ts, a.ip, a.accion, a.entidad, a.entidad_id, a.detalle, a.hash, u.nombre AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id WHERE a.condominio_id = ? ORDER BY a.id DESC LIMIT ? OFFSET ?').all(ctx.cid, lim, off);
  }],
  ['GET', `${C}/usuarios`, { perm: 'usuarios' }, ctx => ctx.db.prepare(`SELECT u.id, u.nombre, u.email, u.activo, u.totp_activo, u.ultimo_acceso, u.bloqueado_hasta, m.rol, m.persona_id, p.nombre AS persona
    FROM membresias m JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN personas p ON p.id = m.persona_id WHERE m.condominio_id = ? ORDER BY m.rol, u.nombre`).all(ctx.cid)],
  ['POST', `${C}/usuarios`, { perm: 'usuarios' }, ctx => {
    const b = v(ctx.body, { nombre: 'str|max120', email: 'email', rol: 'enum|admin|contador|comite|residente', persona_id: 'int|opt' });
    if (b.rol === 'residente' && !b.persona_id) fail(400, 'Vincule al residente con su registro en el padrón.');
    if (b.persona_id) ctx.db.prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?').get(b.persona_id, ctx.cid) || fail(404, 'Persona no encontrada');
    const temporal = token(12) + 'aA1!';
    const r = escribir(ctx, 'usuario_invitado', 'usuario', () => {
      let u = ctx.db.prepare('SELECT id FROM usuarios WHERE email = ?').get(b.email);
      let nuevo = false;
      if (!u) { u = { id: Number(ctx.db.prepare('INSERT INTO usuarios (email, nombre, pass_hash, created_at) VALUES (?,?,?,?)').run(b.email, b.nombre, hashPassword(temporal), Date.now()).lastInsertRowid) }; nuevo = true; }
      if (ctx.db.prepare('SELECT 1 FROM membresias WHERE usuario_id = ? AND condominio_id = ?').get(u.id, ctx.cid)) fail(409, 'El usuario ya tiene acceso a este condominio.');
      ctx.db.prepare('INSERT INTO membresias (usuario_id, condominio_id, rol, persona_id) VALUES (?,?,?,?)').run(u.id, ctx.cid, b.rol, b.persona_id);
      return { id: u.id, nuevo };
    });
    return { ...r, password_temporal: r.nuevo ? temporal : null }; // se muestra una sola vez
  }],
  ['PUT', `${C}/usuarios/:id`, { perm: 'usuarios' }, ctx => {
    const uid = idParam(ctx);
    const b = v(ctx.body, { rol: 'enum|admin|contador|comite|residente', activo: 'bool' });
    if (uid === ctx.user.id) fail(400, 'No puede modificar su propio acceso.');
    return escribir(ctx, b.activo ? 'usuario_actualizado' : 'acceso_revocado', 'usuario', () => {
      if (!b.activo) {
        ctx.db.prepare('DELETE FROM membresias WHERE usuario_id = ? AND condominio_id = ?').run(uid, ctx.cid);
        if (!ctx.db.prepare('SELECT 1 FROM membresias WHERE usuario_id = ?').get(uid)) ctx.db.prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ?').run(uid);
      } else {
        const r = ctx.db.prepare('UPDATE membresias SET rol = ? WHERE usuario_id = ? AND condominio_id = ?').run(b.rol, uid, ctx.cid);
        if (!r.changes) fail(404, 'Usuario no encontrado');
      }
      return uid;
    });
  }],

  // ===== Portal del residente =====
  ['GET', `${C}/mi`, { perm: 'residente' }, ctx => {
    const unidades = unidadesDeResidente(ctx);
    const anio = hoy().slice(0, 4);
    const er = R.estadoResultados(ctx.db, ctx.cid, `${anio}-01`, periodoActual());
    const bancos = ctx.db.prepare("SELECT id, banco, nombre, clabe_mask FROM cuentas_banco WHERE condominio_id = ? AND activo = 1 AND fondo = 'operacion'").all(ctx.cid);
    return {
      bancos,
      unidades: unidades.map(u => ({ unidad: u, ...R.estadoCuenta(ctx.db, ctx.cid, u.id, `${addMonths(periodoActual(), -11)}-01`, hoy()),
        pagos: ctx.db.prepare('SELECT id, folio, fecha, monto_cents, metodo, referencia, estado, motivo FROM pagos WHERE unidad_id = ? ORDER BY fecha DESC, id DESC LIMIT 24').all(u.id) })),
      transparencia: { ejercicio: anio, ingresos: er.totales.ingresos, egresos: er.totales.egresos, partidas: er.egresos.map(e => ({ nombre: e.nombre, total: e.total })).sort((a, b) => b.total - a.total),
        fondo_reserva: R.saldoCuentaClave(ctx.db, ctx.cid, 'FONDO_RESERVA'), cobranza: R.cobranzaMensual(ctx.db, ctx.cid, `${anio}-01`, periodoActual()) },
    };
  }],
  ['POST', `${C}/mi/pagos`, { perm: 'residente' }, ctx => {
    const b = v(ctx.body, { ...pagoBody, comprobante_id: 'int|min1' });
    if (!unidadesDeResidente(ctx).some(u => u.id === b.unidad_id)) fail(404, 'Unidad no encontrada');
    const arch = ctx.db.prepare('SELECT created_by FROM archivos WHERE id = ? AND condominio_id = ?').get(b.comprobante_id, ctx.cid);
    if (!arch || arch.created_by !== ctx.user.id) fail(400, 'Adjunte su comprobante de pago.');
    if (b.fecha > hoy()) fail(400, 'La fecha de pago no puede ser futura.');
    if (!limiteUsuario(ctx, 'reporte_pago')) fail(429, 'Demasiados reportes en poco tiempo.');
    return escribir(ctx, 'pago_reportado', 'pago', () => F.registrarPago(ctx.db, ctx.cid, { ...b, confirmar_duplicado: true }, ctx.user, { validar: false }));
  }],
];

apiRoutes.push(...rutasComunidad({ C, PERMS, escribir, exigir, idParam, q, unidadesDeResidente }));

function limiteUsuario(ctx, k, n = 10) { return rl(`${k}:${ctx.user.id}`, n, 60 * 60 * 1000); }

// Referencia de pago: clave de unidad + condominio + dígito verificador (módulo 97).
function referenciaPago(db, cid, clave) {
  const base = `${String(cid).padStart(3, '0')}${clave.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`.slice(0, 14);
  const num = [...base].map(c => /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)).join('');
  let r = 0; for (const d of num) r = (r * 10 + +d) % 97;
  return `${base}${String(98 - (r * 100) % 97).padStart(2, '0')}`;
}
export { referenciaPago };
