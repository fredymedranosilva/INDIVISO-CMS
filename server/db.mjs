// Base de datos: SQLite embebido (node:sqlite). Integridad reforzada con
// restricciones, índices únicos y triggers que vuelven inmutable la contabilidad.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.INDIVISO_DATA || join(import.meta.dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
export const DB_PATH = join(DATA_DIR, 'indiviso.db');
export const FILES_DIR = join(DATA_DIR, 'archivos'); // adjuntos (comprobantes, facturas, documentos), nombrados por su sha256
mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  superadmin INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, totp_activo INTEGER NOT NULL DEFAULT 0, totp_ultimo_paso INTEGER,
  intentos_fallidos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta INTEGER,
  activo INTEGER NOT NULL DEFAULT 1,
  pass_cambiado_at INTEGER, ultimo_acceso INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  id TEXT PRIMARY KEY,               -- sha256 del token; el token nunca se guarda
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  csrf TEXT NOT NULL,
  ip TEXT, ua TEXT,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revocada INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS condominios (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  razon_social TEXT, rfc TEXT, direccion TEXT, ciudad TEXT,
  dia_vencimiento INTEGER NOT NULL DEFAULT 10 CHECK (dia_vencimiento BETWEEN 1 AND 28),
  dias_gracia INTEGER NOT NULL DEFAULT 0 CHECK (dias_gracia BETWEEN 0 AND 60),
  tasa_recargo_bp INTEGER NOT NULL DEFAULT 300 CHECK (tasa_recargo_bp BETWEEN 0 AND 2000),
  pct_reserva_bp INTEGER NOT NULL DEFAULT 1000 CHECK (pct_reserva_bp BETWEEN 0 AND 5000),
  umbral_aprobacion_cents INTEGER NOT NULL DEFAULT 1000000 CHECK (umbral_aprobacion_cents >= 0),
  activo INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS membresias (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  rol TEXT NOT NULL CHECK (rol IN ('admin','contador','comite','residente')),
  persona_id INTEGER REFERENCES personas(id),
  PRIMARY KEY (usuario_id, condominio_id)
);

CREATE TABLE IF NOT EXISTS unidades (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  clave TEXT NOT NULL,
  torre TEXT,
  tipo TEXT NOT NULL DEFAULT 'departamento',
  m2 REAL CHECK (m2 IS NULL OR m2 >= 0),
  indiviso_ppm INTEGER NOT NULL DEFAULT 0 CHECK (indiviso_ppm BETWEEN 0 AND 1000000),
  cuota_cents INTEGER NOT NULL DEFAULT 0 CHECK (cuota_cents >= 0),
  referencia TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'ocupada' CHECK (estado IN ('ocupada','vacante','renta')),
  activo INTEGER NOT NULL DEFAULT 1,
  notas TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (condominio_id, clave)
);

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  nombre TEXT NOT NULL, email TEXT, telefono TEXT, rfc TEXT, notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_personas_email ON personas(condominio_id, email COLLATE NOCASE) WHERE email IS NOT NULL AND activo = 1;

CREATE TABLE IF NOT EXISTS unidad_personas (
  id INTEGER PRIMARY KEY,
  unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  rol TEXT NOT NULL CHECK (rol IN ('propietario','inquilino','responsable')),
  UNIQUE (unidad_id, persona_id, rol)
);

CREATE TABLE IF NOT EXISTS cuentas (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  codigo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('activo','pasivo','patrimonio','ingreso','egreso')),
  naturaleza TEXT NOT NULL CHECK (naturaleza IN ('D','A')),
  clave TEXT,                         -- cuentas de sistema (BANCOS, CXC, ...)
  presupuestable INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (condominio_id, codigo)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cuentas_clave ON cuentas(condominio_id, clave) WHERE clave IS NOT NULL;

CREATE TABLE IF NOT EXISTS periodos (
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  periodo TEXT NOT NULL CHECK (periodo GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  estado TEXT NOT NULL CHECK (estado IN ('abierto','cerrado')),
  cerrado_por INTEGER, cerrado_at INTEGER,
  PRIMARY KEY (condominio_id, periodo)
);

CREATE TABLE IF NOT EXISTS polizas (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('I','E','D')),
  folio INTEGER NOT NULL,
  fecha TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  periodo TEXT NOT NULL,
  concepto TEXT NOT NULL,
  origen TEXT NOT NULL,
  origen_id INTEGER,
  reversa_de INTEGER REFERENCES polizas(id),
  reversada_por INTEGER REFERENCES polizas(id),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  created_by INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (condominio_id, tipo, folio)
);
CREATE INDEX IF NOT EXISTS ix_polizas_periodo ON polizas(condominio_id, periodo);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  poliza_id INTEGER NOT NULL REFERENCES polizas(id),
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  unidad_id INTEGER REFERENCES unidades(id),
  debe_cents INTEGER NOT NULL DEFAULT 0 CHECK (debe_cents >= 0),
  haber_cents INTEGER NOT NULL DEFAULT 0 CHECK (haber_cents >= 0),
  concepto TEXT,
  CHECK ((debe_cents = 0) <> (haber_cents = 0))
);
CREATE INDEX IF NOT EXISTS ix_mov_poliza ON movimientos(poliza_id);
CREATE INDEX IF NOT EXISTS ix_mov_cuenta ON movimientos(cuenta_id);
CREATE INDEX IF NOT EXISTS ix_mov_unidad ON movimientos(unidad_id);

CREATE TABLE IF NOT EXISTS cargos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ordinaria','extraordinaria','recargo','multa','otro')),
  concepto TEXT NOT NULL,
  periodo TEXT NOT NULL,
  fecha TEXT NOT NULL,
  vencimiento TEXT NOT NULL,
  monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  reserva_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserva_cents >= 0),
  cuenta_ingreso_id INTEGER NOT NULL REFERENCES cuentas(id),
  poliza_id INTEGER REFERENCES polizas(id),
  lote TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,     -- impide emitir dos veces el mismo cargo
  cancelado_at INTEGER, cancelado_por INTEGER, motivo_cancel TEXT, cancel_poliza_id INTEGER,
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cargos_unidad ON cargos(unidad_id);

CREATE TABLE IF NOT EXISTS cuentas_banco (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  nombre TEXT NOT NULL, banco TEXT NOT NULL, numero_mask TEXT, clabe_mask TEXT,
  cuenta_id INTEGER NOT NULL UNIQUE REFERENCES cuentas(id),
  fondo TEXT NOT NULL DEFAULT 'operacion' CHECK (fondo IN ('operacion','reserva')),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS archivos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  sha256 TEXT NOT NULL, nombre TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
  created_by INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (condominio_id, sha256)
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  folio INTEGER,
  fecha TEXT NOT NULL,
  monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  metodo TEXT NOT NULL CHECK (metodo IN ('transferencia','deposito','efectivo','tarjeta','cheque','domiciliacion')),
  referencia TEXT,
  cuenta_banco_id INTEGER REFERENCES cuentas_banco(id),
  comprobante_id INTEGER REFERENCES archivos(id),
  estado TEXT NOT NULL CHECK (estado IN ('por_validar','aplicado','rechazado','cancelado')),
  idem_key TEXT NOT NULL UNIQUE,       -- idempotencia: reintentos/doble clic no duplican
  notas TEXT, motivo TEXT,
  reportado_por INTEGER, validado_por INTEGER, validado_at INTEGER,
  poliza_id INTEGER, cancel_poliza_id INTEGER,
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_folio ON pagos(condominio_id, folio) WHERE folio IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_ref ON pagos(condominio_id, cuenta_banco_id, referencia, monto_cents)
  WHERE referencia IS NOT NULL AND estado IN ('por_validar','aplicado');
CREATE INDEX IF NOT EXISTS ix_pagos_unidad ON pagos(unidad_id);

CREATE TABLE IF NOT EXISTS aplicaciones (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL,
  cargo_id INTEGER NOT NULL REFERENCES cargos(id),
  pago_id INTEGER REFERENCES pagos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('pago','bonificacion')),
  monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  motivo TEXT,
  poliza_id INTEGER,
  revertida INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at INTEGER NOT NULL,
  CHECK ((tipo = 'pago') = (pago_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_apl_cargo ON aplicaciones(cargo_id);
CREATE INDEX IF NOT EXISTS ix_apl_pago ON aplicaciones(pago_id);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  nombre TEXT NOT NULL, rfc TEXT, giro TEXT, email TEXT, telefono TEXT, clabe_mask TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prov_rfc ON proveedores(condominio_id, rfc) WHERE rfc IS NOT NULL;

CREATE TABLE IF NOT EXISTS egresos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  folio INTEGER NOT NULL,
  proveedor_id INTEGER REFERENCES proveedores(id),
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  fondo TEXT NOT NULL DEFAULT 'operacion' CHECK (fondo IN ('operacion','reserva')),
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  iva_cents INTEGER NOT NULL DEFAULT 0 CHECK (iva_cents >= 0),
  retenciones_cents INTEGER NOT NULL DEFAULT 0 CHECK (retenciones_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  factura_folio TEXT, cfdi_uuid TEXT,
  estado TEXT NOT NULL CHECK (estado IN ('por_aprobar','aprobado','pagado','rechazado','cancelado')),
  metodo_pago TEXT, cuenta_banco_id INTEGER REFERENCES cuentas_banco(id), referencia_pago TEXT, fecha_pago TEXT,
  comprobante_id INTEGER REFERENCES archivos(id),
  idem_key TEXT NOT NULL UNIQUE,
  motivo TEXT,
  created_by INTEGER NOT NULL, aprobado_por INTEGER, aprobado_at INTEGER, pagado_por INTEGER,
  poliza_prov_id INTEGER, poliza_pago_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (condominio_id, folio),
  CHECK (total_cents = subtotal_cents + iva_cents - retenciones_cents)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_egresos_cfdi ON egresos(condominio_id, cfdi_uuid COLLATE NOCASE)
  WHERE cfdi_uuid IS NOT NULL AND estado NOT IN ('cancelado','rechazado');

CREATE TABLE IF NOT EXISTS banco_movs (
  id INTEGER PRIMARY KEY,
  cuenta_banco_id INTEGER NOT NULL REFERENCES cuentas_banco(id),
  fecha TEXT NOT NULL, descripcion TEXT, referencia TEXT,
  cargo_cents INTEGER NOT NULL DEFAULT 0 CHECK (cargo_cents >= 0),
  abono_cents INTEGER NOT NULL DEFAULT 0 CHECK (abono_cents >= 0),
  huella TEXT NOT NULL UNIQUE,         -- reimportar el mismo estado de cuenta no duplica
  importacion TEXT,
  conciliado_tipo TEXT, conciliado_id INTEGER, conciliado_por INTEGER, conciliado_at INTEGER,
  CHECK ((cargo_cents = 0) <> (abono_cents = 0))
);

CREATE TABLE IF NOT EXISTS presupuestos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  ejercicio INTEGER NOT NULL,
  version INTEGER NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('borrador','aprobado','sustituido')),
  acta TEXT, notas TEXT,
  aprobado_por INTEGER, aprobado_at INTEGER,
  created_by INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (condominio_id, ejercicio, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_presup_aprobado ON presupuestos(condominio_id, ejercicio) WHERE estado = 'aprobado';

CREATE TABLE IF NOT EXISTS presupuesto_lineas (
  presupuesto_id INTEGER NOT NULL REFERENCES presupuestos(id),
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  monto_cents INTEGER NOT NULL CHECK (monto_cents >= 0),
  PRIMARY KEY (presupuesto_id, cuenta_id, mes)
);

CREATE TABLE IF NOT EXISTS convenios (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  fecha TEXT NOT NULL,
  monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  parcialidades INTEGER NOT NULL CHECK (parcialidades BETWEEN 1 AND 60),
  estado TEXT NOT NULL CHECK (estado IN ('vigente','cumplido','cancelado')),
  suspende_recargos INTEGER NOT NULL DEFAULT 1,
  notas TEXT,
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_convenio_vigente ON convenios(unidad_id) WHERE estado = 'vigente';
CREATE TABLE IF NOT EXISTS convenio_parcialidades (
  convenio_id INTEGER NOT NULL REFERENCES convenios(id),
  numero INTEGER NOT NULL, vencimiento TEXT NOT NULL, monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  PRIMARY KEY (convenio_id, numero)
);

CREATE TABLE IF NOT EXISTS gestiones (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL, unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  tipo TEXT NOT NULL, nota TEXT, promesa_fecha TEXT, promesa_cents INTEGER,
  created_by INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  usuario_id INTEGER, condominio_id INTEGER, ip TEXT,
  accion TEXT NOT NULL, entidad TEXT, entidad_id INTEGER, detalle TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_audit_condo ON auditoria(condominio_id, ts);

CREATE TABLE IF NOT EXISTS respaldos (
  id INTEGER PRIMARY KEY,
  archivo TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  motivo TEXT, verificado INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

-- ===== Finanzas adicionales =====
CREATE TABLE IF NOT EXISTS fondos (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  nombre TEXT NOT NULL,
  cuenta_id INTEGER NOT NULL UNIQUE REFERENCES cuentas(id),
  meta_cents INTEGER CHECK (meta_cents IS NULL OR meta_cents >= 0),
  descripcion TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cargos_recurrentes (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  unidad_id INTEGER REFERENCES unidades(id),          -- NULL = todas las unidades activas
  tipo TEXT NOT NULL CHECK (tipo IN ('extraordinaria','otro','multa')),
  concepto TEXT NOT NULL,
  monto_cents INTEGER NOT NULL CHECK (monto_cents > 0),
  desde TEXT NOT NULL CHECK (desde GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  hasta TEXT CHECK (hasta IS NULL OR hasta GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  activo INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER, created_at INTEGER NOT NULL
);

-- ===== Comunidad: avisos, calendario, documentos, teléfonos, cosas perdidas y encuestas =====
CREATE TABLE IF NOT EXISTS comunidad (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('aviso','evento','documento','telefono','perdido')),
  titulo TEXT NOT NULL,
  cuerpo TEXT, categoria TEXT,
  fecha TEXT, hora TEXT, lugar TEXT, telefono TEXT,
  archivo_id INTEGER REFERENCES archivos(id),
  fijado INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente','archivado','entregado')),
  publico INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_comunidad ON comunidad(condominio_id, tipo, estado);

CREATE TABLE IF NOT EXISTS encuestas (
  id INTEGER PRIMARY KEY,
  condominio_id INTEGER NOT NULL REFERENCES condominios(id),
  pregunta TEXT NOT NULL, descripcion TEXT,
  cierra TEXT NOT NULL,
  ponderada INTEGER NOT NULL DEFAULT 0,                -- 1 = resultados por porcentaje de indiviso
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS encuesta_opciones (
  id INTEGER PRIMARY KEY,
  encuesta_id INTEGER NOT NULL REFERENCES encuestas(id),
  texto TEXT NOT NULL, orden INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS encuesta_votos (
  encuesta_id INTEGER NOT NULL REFERENCES encuestas(id),
  unidad_id INTEGER NOT NULL REFERENCES unidades(id),
  opcion_id INTEGER NOT NULL REFERENCES encuesta_opciones(id),
  usuario_id INTEGER, registrado_por INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (encuesta_id, unidad_id)                 -- un voto por unidad
);
CREATE TRIGGER IF NOT EXISTS t_voto_no_upd BEFORE UPDATE ON encuesta_votos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: un voto emitido no se modifica'); END;
CREATE TRIGGER IF NOT EXISTS t_voto_no_del BEFORE DELETE ON encuesta_votos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: un voto emitido no se elimina'); END;

-- ===== Códigos de respaldo de la verificación en dos pasos (solo hashes; un solo uso) =====
CREATE TABLE IF NOT EXISTS totp_respaldo (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  hash TEXT NOT NULL,
  usado_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_totp_respaldo ON totp_respaldo(usuario_id, hash);

-- ===== Índices para consultas por condominio y periodo =====
CREATE INDEX IF NOT EXISTS ix_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX IF NOT EXISTS ix_cargos_condo_periodo ON cargos(condominio_id, periodo);
CREATE INDEX IF NOT EXISTS ix_pagos_condo_fecha ON pagos(condominio_id, fecha);
CREATE INDEX IF NOT EXISTS ix_egresos_condo_fecha ON egresos(condominio_id, fecha);
CREATE INDEX IF NOT EXISTS ix_aud_condo ON auditoria(condominio_id, id);
CREATE INDEX IF NOT EXISTS ix_banco_movs_cuenta ON banco_movs(cuenta_banco_id, fecha);

-- ===== Inmutabilidad: lo contabilizado no se edita ni se borra; se revierte. =====
CREATE TRIGGER IF NOT EXISTS t_mov_no_upd BEFORE UPDATE ON movimientos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: los movimientos contables no se modifican'); END;
CREATE TRIGGER IF NOT EXISTS t_mov_no_del BEFORE DELETE ON movimientos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: los movimientos contables no se eliminan'); END;
CREATE TRIGGER IF NOT EXISTS t_pol_no_del BEFORE DELETE ON polizas BEGIN SELECT RAISE(ABORT, 'INMUTABLE: las pólizas no se eliminan; use una contrapóliza'); END;
CREATE TRIGGER IF NOT EXISTS t_pol_upd BEFORE UPDATE ON polizas
  WHEN NOT (OLD.reversada_por IS NULL AND NEW.reversada_por IS NOT NULL
        AND NEW.id = OLD.id AND NEW.fecha = OLD.fecha AND NEW.periodo = OLD.periodo AND NEW.total_cents = OLD.total_cents
        AND NEW.concepto = OLD.concepto AND NEW.folio = OLD.folio AND NEW.tipo = OLD.tipo AND NEW.condominio_id = OLD.condominio_id)
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: la póliza solo puede marcarse como revertida'); END;
CREATE TRIGGER IF NOT EXISTS t_pol_periodo2 BEFORE INSERT ON polizas
  WHEN NEW.origen NOT IN ('cierre_ejercicio','reapertura_ejercicio')
    AND EXISTS (SELECT 1 FROM periodos p WHERE p.condominio_id = NEW.condominio_id AND p.periodo = NEW.periodo AND p.estado = 'cerrado')
  BEGIN SELECT RAISE(ABORT, 'PERIODO_CERRADO: el periodo contable está cerrado'); END;
CREATE TRIGGER IF NOT EXISTS t_cargo_no_del BEFORE DELETE ON cargos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: los cargos no se eliminan; se cancelan'); END;
CREATE TRIGGER IF NOT EXISTS t_cargo_upd BEFORE UPDATE ON cargos
  WHEN NOT (OLD.cancelado_at IS NULL AND NEW.monto_cents = OLD.monto_cents AND NEW.unidad_id = OLD.unidad_id
            AND NEW.dedupe_key = OLD.dedupe_key AND NEW.fecha = OLD.fecha AND NEW.vencimiento = OLD.vencimiento
            AND NEW.cuenta_ingreso_id = OLD.cuenta_ingreso_id AND NEW.reserva_cents = OLD.reserva_cents)
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el cargo ya no puede modificarse'); END;
CREATE TRIGGER IF NOT EXISTS t_pago_no_del BEFORE DELETE ON pagos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: los pagos no se eliminan; se cancelan'); END;
CREATE TRIGGER IF NOT EXISTS t_pago_upd BEFORE UPDATE ON pagos
  WHEN OLD.estado IN ('rechazado','cancelado')
    OR NEW.monto_cents <> OLD.monto_cents OR NEW.unidad_id <> OLD.unidad_id OR NEW.idem_key <> OLD.idem_key
    OR (OLD.estado = 'aplicado' AND NEW.estado NOT IN ('aplicado','cancelado'))
    OR (OLD.estado = 'aplicado' AND NEW.fecha <> OLD.fecha)
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el pago no puede modificarse en su estado actual'); END;
CREATE TRIGGER IF NOT EXISTS t_apl_no_del BEFORE DELETE ON aplicaciones BEGIN SELECT RAISE(ABORT, 'INMUTABLE: las aplicaciones no se eliminan'); END;
CREATE TRIGGER IF NOT EXISTS t_apl_upd BEFORE UPDATE ON aplicaciones
  WHEN NOT (OLD.revertida = 0 AND NEW.revertida = 1 AND NEW.monto_cents = OLD.monto_cents AND NEW.cargo_id = OLD.cargo_id)
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: la aplicación solo puede revertirse'); END;
CREATE TRIGGER IF NOT EXISTS t_egr_no_del BEFORE DELETE ON egresos BEGIN SELECT RAISE(ABORT, 'INMUTABLE: los egresos no se eliminan; se cancelan'); END;
CREATE TRIGGER IF NOT EXISTS t_egr_upd BEFORE UPDATE ON egresos
  WHEN OLD.estado IN ('cancelado','rechazado')
    OR (OLD.estado IN ('aprobado','pagado') AND (NEW.total_cents <> OLD.total_cents OR NEW.cuenta_id <> OLD.cuenta_id OR NEW.fondo <> OLD.fondo OR NEW.fecha <> OLD.fecha))
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el egreso no puede modificarse en su estado actual'); END;
CREATE TRIGGER IF NOT EXISTS t_aud_no_upd BEFORE UPDATE ON auditoria BEGIN SELECT RAISE(ABORT, 'INMUTABLE: bitácora de solo inserción'); END;
CREATE TRIGGER IF NOT EXISTS t_aud_no_del BEFORE DELETE ON auditoria BEGIN SELECT RAISE(ABORT, 'INMUTABLE: bitácora de solo inserción'); END;
CREATE TRIGGER IF NOT EXISTS t_presup_lineas_ins BEFORE INSERT ON presupuesto_lineas
  WHEN (SELECT estado FROM presupuestos WHERE id = NEW.presupuesto_id) <> 'borrador'
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el presupuesto aprobado no se modifica; cree una nueva versión'); END;
CREATE TRIGGER IF NOT EXISTS t_presup_lineas_upd BEFORE UPDATE ON presupuesto_lineas
  WHEN (SELECT estado FROM presupuestos WHERE id = OLD.presupuesto_id) <> 'borrador'
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el presupuesto aprobado no se modifica; cree una nueva versión'); END;
CREATE TRIGGER IF NOT EXISTS t_presup_lineas_del BEFORE DELETE ON presupuesto_lineas
  WHEN (SELECT estado FROM presupuestos WHERE id = OLD.presupuesto_id) <> 'borrador'
  BEGIN SELECT RAISE(ABORT, 'INMUTABLE: el presupuesto aprobado no se modifica; cree una nueva versión'); END;
CREATE TRIGGER IF NOT EXISTS t_periodo_reabrir BEFORE UPDATE ON periodos
  WHEN OLD.estado = 'cerrado' AND NEW.estado = 'abierto' AND (SELECT v FROM meta WHERE k = 'permitir_reapertura') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'PERIODO_CERRADO: reapertura no autorizada'); END;
`;

export function openDb(path = DB_PATH) {
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
           PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;`);
  db.exec(SCHEMA);
  migrar(db);
  if (fresh) { try { chmodSync(path, 0o600); } catch { /* sistemas sin permisos POSIX */ } }
  return db;
}

// Columnas agregadas después de la primera versión: se añaden a bases existentes sin perder datos.
const COLUMNAS = [
  ['condominios', 'pronto_pago_bp', 'INTEGER NOT NULL DEFAULT 0 CHECK (pronto_pago_bp BETWEEN 0 AND 5000)'],
  ['condominios', 'pronto_pago_dia', 'INTEGER NOT NULL DEFAULT 0 CHECK (pronto_pago_dia BETWEEN 0 AND 28)'],
  ['cargos', 'fondo_cuenta_id', 'INTEGER REFERENCES cuentas(id)'],    // fondo que recibe la aportación (NULL = fondo de reserva)
  ['egresos', 'fondo_id', 'INTEGER REFERENCES fondos(id)'],           // fondo específico del que se paga (NULL = reserva)
  // recargos: «saldo» = % sobre el saldo vencido · «cuota» = % sobre cada cuota vencida · «fijo» = monto por cuota vencida
  ['condominios', 'recargo_modo', "TEXT NOT NULL DEFAULT 'saldo' CHECK (recargo_modo IN ('saldo','cuota','fijo'))"],
  ['condominios', 'recargo_fijo_cents', 'INTEGER NOT NULL DEFAULT 0 CHECK (recargo_fijo_cents >= 0)'],
  // seguridad: contraseña temporal de un solo uso (el usuario debe cambiarla al entrar) y su vigencia
  ['usuarios', 'debe_cambiar_pass', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'pass_temporal_hasta', 'INTEGER'],
  // identidad: logotipo del condominio para la interfaz y los reportes
  ['condominios', 'logo_archivo_id', 'INTEGER REFERENCES archivos(id)'],
];
function migrar(db) {
  for (const [t, c, def] of COLUMNAS) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  }
  db.exec('DROP TRIGGER IF EXISTS t_pol_periodo'); // sustituido por t_pol_periodo2 (permite asentar el cierre de ejercicio)
}

// Transacción con bloqueo de escritura inmediato: serializa folios y evita carreras.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw e;
  }
}
