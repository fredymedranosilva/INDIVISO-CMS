// Datos de demostración generados con el mismo motor financiero (nada se inserta "a mano"
// en tablas contables). Uso:
//   node server/seed.mjs            → crea la base demo si no existe
//   node server/seed.mjs --reset    → borra la base DEMO y la regenera
//   node server/seed.mjs --vacio    → base vacía con solo el superadministrador
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, tx, DB_PATH, DATA_DIR } from './db.mjs';
import { hashPassword, token, audit, sha256 } from './security.mjs';
import { hoy, addMonths, addDays, periodoDe, prorratear } from './util.mjs';
import * as F from './finanzas.mjs';
import { referenciaPago } from './api.mjs';

const args = process.argv.slice(2);
if (existsSync(DB_PATH)) {
  if (!args.includes('--reset')) { console.log('La base ya existe. Use --reset para regenerar la demo (se borran TODOS los datos).'); process.exit(1); }
  for (const s of ['', '-wal', '-shm']) rmSync(DB_PATH + s, { force: true });
}
const db = openDb();
const HOY = hoy();
const ACTUAL = periodoDe(HOY);

// PRNG determinista para que la demo sea reproducible
let seed = 20261106;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const dia = (p, d) => `${p}-${String(Math.min(d, 28)).padStart(2, '0')}`;
const pesos = n => Math.round(n * 100);

const creds = [];
function usuario(email, nombre, superadmin = false) {
  const pass = `${token(9)}-Aa1`;
  const id = Number(db.prepare('INSERT INTO usuarios (email, nombre, pass_hash, superadmin, created_at, pass_cambiado_at) VALUES (?,?,?,?,?,?)').run(email, nombre, hashPassword(pass), superadmin ? 1 : 0, Date.now(), Date.now()).lastInsertRowid);
  creds.push([email, pass, nombre]);
  return { id, nombre, superadmin: superadmin ? 1 : 0 };
}
function guardarCreds() {
  const f = join(DATA_DIR, 'credenciales-demo.txt');
  writeFileSync(f, 'Indiviso CMS · usuarios de PRUEBA (no usar en producción)\n\n' + creds.map(([e, p, n]) => `${n.padEnd(34)} ${e.padEnd(30)} ${p}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`Credenciales de prueba en ${f}`);
}

if (args.includes('--vacio')) {
  tx(db, () => { const u = usuario('direccion@indiviso.test', 'Superadministrador', true); audit(db, { usuario_id: u.id, accion: 'instalacion' }); });
  guardarCreds();
  process.exit(0);
}

const NOMBRES = ['Alejandra', 'Bernardo', 'Carmen', 'Daniel', 'Elena', 'Fernando', 'Gabriela', 'Héctor', 'Isabel', 'Javier', 'Karla', 'Luis', 'Mariana', 'Nicolás', 'Olga', 'Pablo', 'Regina', 'Sergio', 'Teresa', 'Ulises', 'Valeria', 'Ximena', 'Yolanda', 'Rodrigo', 'Patricia', 'Andrés', 'Lucía', 'Mauricio', 'Sofía', 'Emilio'];
const APELLIDOS = ['García', 'Hernández', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Cruz', 'Flores', 'Gómez', 'Morales', 'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz', 'Mendoza', 'Aguilar', 'Ortiz', 'Castillo', 'Romero', 'Navarro', 'Salinas', 'Medina'];
const sinAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const superU = usuario('direccion@indiviso.test', 'Dirección MEDRATMOS', true);
const admin = usuario('admin@indiviso.test', 'Fredy Medrano');
const contador = usuario('contador@indiviso.test', 'C.P. Laura Ríos');
const comite = usuario('comite@indiviso.test', 'Arq. Tomás Villaseñor (Comité)');
const residenteU = usuario('residente@indiviso.test', 'Mariana Torres');

function crearCondo(def) {
  return tx(db, () => {
    const cid = F.crearCondominio(db, def.datos, superU);
    const bOp = F.crearCuentaBanco(db, cid, { nombre: 'Operación', banco: 'Banorte', numero: def.cuentaOp, clabe: '072180' + def.cuentaOp.padStart(12, '0'), fondo: 'operacion' });
    const bRes = def.cuentaRes ? F.crearCuentaBanco(db, cid, { nombre: 'Fondo de reserva', banco: 'Banorte', numero: def.cuentaRes, clabe: '072180' + def.cuentaRes.padStart(12, '0'), fondo: 'reserva' }) : null;
    const pesosInd = def.unidades.map(u => u.m2);
    const ind = prorratear(1_000_000, pesosInd);
    const cuotas = prorratear(def.cuotaMensual * 100, pesosInd).map(c => Math.round(c / 1000) * 1000);
    const unidades = def.unidades.map((u, i) => {
      const id = Number(db.prepare('INSERT INTO unidades (condominio_id, clave, torre, tipo, m2, indiviso_ppm, cuota_cents, referencia, estado, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(cid, u.clave, u.torre, 'departamento', u.m2, ind[i], cuotas[i], referenciaPago(db, cid, u.clave), u.estado, Date.now()).lastInsertRowid);
      const nombre = `${pick(NOMBRES)} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`;
      const email = `${sinAcento(nombre.split(' ')[0])}.${sinAcento(nombre.split(' ')[1])}${id}@correo.test`;
      const pid = Number(db.prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, created_at) VALUES (?,?,?,?,?)').run(cid, nombre, email, `55 ${ri(1000, 9999)} ${ri(1000, 9999)}`, Date.now()).lastInsertRowid);
      db.prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)').run(id, pid, 'propietario');
      if (u.estado === 'renta') {
        const n2 = `${pick(NOMBRES)} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`;
        const p2 = Number(db.prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, created_at) VALUES (?,?,?,?,?)').run(cid, n2, `${sinAcento(n2.split(' ')[0])}.inq${id}@correo.test`, `55 ${ri(1000, 9999)} ${ri(1000, 9999)}`, Date.now()).lastInsertRowid);
        db.prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)').run(id, p2, 'inquilino');
      }
      return { id, clave: u.clave, cuota: cuotas[i], perfil: u.perfil, persona: pid, ref: referenciaPago(db, cid, u.clave) };
    });
    const provs = Object.fromEntries(def.proveedores.map(([k, nombre, rfc, giro]) => [k, Number(db.prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, created_at) VALUES (?,?,?,?,?)').run(cid, nombre, rfc, giro, Date.now()).lastInsertRowid)]));
    return { cid, bOp, bRes, unidades, provs };
  });
}

const cuentaPorCodigo = (cid, codigo) => db.prepare('SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = ?').get(cid, codigo).id;
const cuentaBancoContable = bid => db.prepare('SELECT cuenta_id FROM cuentas_banco WHERE id = ?').get(bid).cuenta_id;

function simular(def, C, roles) {
  const { cid, bOp, bRes, unidades, provs } = C;
  const inicio = addMonths(ACTUAL, -12);
  const extractos = new Map(); // periodo → filas del estado de cuenta bancario
  const mov = (p, f) => { if (!extractos.has(p)) extractos.set(p, []); extractos.get(p).push(f); };

  tx(db, () => {
    const ini = `${inicio}-01`;
    F.polizaManual(db, cid, { tipo: 'D', fecha: ini, concepto: 'Saldos iniciales según entrega-recepción de la administración anterior', lineas: [
      { cuenta: cuentaBancoContable(bOp), debe: pesos(def.saldoOp) }, ...(bRes ? [{ cuenta: cuentaBancoContable(bRes), debe: pesos(def.saldoRes) }] : []),
      { cuenta: F.cuenta(db, cid, 'FONDO_RESERVA'), haber: pesos(def.saldoRes) }, { cuenta: F.cuenta(db, cid, 'REMANENTE'), haber: pesos(def.saldoOp + (bRes ? 0 : -def.saldoRes)) },
    ].filter(l => (l.debe || l.haber) > 0) }, roles.contador);
    mov(inicio, { fecha: ini, descripcion: 'SALDO INICIAL', referencia: null, cargo_cents: 0, abono_cents: pesos(def.saldoOp) });
  });

  let idem = 0;
  for (let p = inicio; p <= ACTUAL; p = addMonths(p, 1)) {
    const esActual = p === ACTUAL;
    const maxDia = esActual ? +HOY.slice(8, 10) - 1 : 28;
    tx(db, () => {
      F.emitirCuotas(db, cid, p, roles.contador);
      F.calcularRecargos(db, cid, p, roles.contador);
      if (def.extraordinaria && p === addMonths(ACTUAL, def.extraordinaria.mes)) {
        F.emitirExtraordinaria(db, cid, { concepto: def.extraordinaria.concepto, total_cents: pesos(def.extraordinaria.total), metodo: 'indiviso', destino: 'operacion', fecha: `${p}-01`, vencimiento: `${addMonths(p, 1)}-10` }, roles.contador);
      }
    });

    // ---- Cobranza según el perfil de pago de cada unidad ----
    for (const u of unidades) {
      const debe = F.cargosAbiertos(db, u.id).reduce((a, c) => a + c.saldo_cents, 0);
      let monto = 0, d = ri(1, 12);
      switch (u.perfil) {
        case 'puntual': monto = debe; if (rnd() < 0.1) d = ri(14, 27); break;
        case 'tardio': if ((+p.slice(5, 7)) % 2 === 0) { monto = debe; d = ri(8, 24); } break;
        case 'moroso': if (rnd() < 0.22) monto = u.cuota; d = ri(5, 25); break;
        case 'adelantado': if (F.creditosDisponibles(db, u.id).length === 0) monto = debe + u.cuota * 5; break;
      }
      if (monto <= 0) continue;
      if (esActual && d > maxDia) { if (u.perfil !== 'puntual' || rnd() < 0.5) continue; d = ri(1, Math.max(1, maxDia)); }
      const fecha = dia(p, d);
      const metodo = rnd() < 0.78 ? 'transferencia' : rnd() < 0.7 ? 'deposito' : 'efectivo';
      const conRef = metodo === 'transferencia' && rnd() < 0.75;
      const referencia = metodo === 'efectivo' ? null : `${metodo === 'transferencia' ? 'MBAN' : 'DEP'}${ri(10000000, 99999999)}${idem}`; // clave de rastreo: única por operación
      tx(db, () => F.registrarPago(db, cid, { unidad_id: u.id, fecha, monto_cents: monto, metodo, referencia, cuenta_banco_id: metodo === 'efectivo' ? null : bOp, idem_key: `SEED-${cid}-${++idem}-${token(4)}`, confirmar_duplicado: true }, roles.contador));
      const fb = rnd() < 0.3 && d < 28 ? addDays(fecha, 1) : fecha;
      if (metodo !== 'efectivo') mov(p, { fecha: fb, descripcion: metodo === 'transferencia' ? `SPEI RECIBIDO ${conRef ? 'REF ' + u.ref : 'BCO ' + pick(['BBVA', 'SANTANDER', 'HSBC', 'BANAMEX', 'SCOTIA'])}` : 'DEPOSITO EN VENTANILLA', referencia, cargo_cents: 0, abono_cents: monto });
    }

    // ---- Egresos del mes ----
    const nMes = +p.slice(5, 7);
    for (const g of def.gastos) {
      if (g.meses && !g.meses.includes(nMes)) continue;
      const total = pesos(g.monto * (g.fijo ? 1 : 0.9 + rnd() * 0.2));
      const fecha = dia(p, g.dia ?? ri(2, 18));
      if (esActual && fecha >= HOY) continue;
      const factura = g.prov !== null;
      const sub = factura ? Math.round(total / 1.16) : total;
      const e = tx(db, () => F.crearEgreso(db, cid, { proveedor_id: g.prov ? provs[g.prov] : null, cuenta_id: cuentaPorCodigo(cid, g.cuenta), fondo: g.fondo || 'operacion', fecha, concepto: `${g.concepto} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][nMes - 1]}`,
        subtotal_cents: sub, iva_cents: total - sub, retenciones_cents: 0, factura_folio: factura ? `F${ri(10000, 99999)}` : null, cfdi_uuid: factura ? randomUUID().toUpperCase() : null, idem_key: `SEEDE-${cid}-${++idem}-${token(4)}` }, roles.contador));
      if (esActual && g.pendiente) continue; // queda por aprobar / por pagar en el mes en curso
      if (e.requiere_aprobacion) tx(db, () => F.aprobarEgreso(db, cid, e.id, true, null, roles.aprobador));
      const fp = addDays(fecha, ri(0, 4)); if (esActual && fp >= HOY) continue;
      const metodo = g.domiciliado ? 'domiciliacion' : 'transferencia';
      const banco = g.fondo === 'reserva' && bRes ? bRes : bOp;
      const ref = `${ri(100000, 999999)}`;
      tx(db, () => F.pagarEgreso(db, cid, e.id, { fecha_pago: fp, metodo, cuenta_banco_id: banco, referencia: ref }, roles.contador));
      if (banco === bOp) mov(periodoDe(fp), { fecha: fp, descripcion: g.domiciliado ? `CARGO DOMICILIADO ${g.concepto.toUpperCase()}` : `SPEI ENVIADO ${g.prov ? def.proveedores.find(x => x[0] === g.prov)[1].toUpperCase().slice(0, 30) : g.concepto.toUpperCase()}`, referencia: ref, cargo_cents: total, abono_cents: 0 });
    }
  }

  // ---- Estados de cuenta bancarios importados hasta el mes anterior ----
  const ant = addMonths(ACTUAL, -1);
  for (const [p, filas] of [...extractos].sort()) {
    if (p > ant) continue;
    if (p === ant) filas.push({ fecha: dia(p, 27), descripcion: `SPEI RECIBIDO REF ${unidades[3].ref}`, referencia: unidades[3].ref, cargo_cents: 0, abono_cents: unidades[3].cuota },
      { fecha: dia(p, 29), descripcion: 'DEPOSITO SIN REFERENCIA', referencia: null, cargo_cents: 0, abono_cents: pesos(1850) });
    tx(db, () => F.importarMovimientosBanco(db, cid, bOp, filas, roles.contador));
  }
  tx(db, () => { const m = db.prepare("SELECT id FROM banco_movs WHERE cuenta_banco_id = ? AND descripcion = 'SALDO INICIAL'").get(bOp); if (m) F.conciliarManual(db, cid, m.id, 'otro', null, roles.contador); });
}

// ===================== Residencial Horizonte =====================
const torreH = [];
for (const t of ['A', 'B']) for (let piso = 1; piso <= 6; piso++) for (let n = 1; n <= 4; n++) {
  const m2 = n === 1 ? 120 : n === 4 ? 78 : 95;
  torreH.push({ clave: `${t}-${piso}0${n}`, torre: `Torre ${t}`, m2, estado: rnd() < 0.15 ? 'renta' : rnd() < 0.05 ? 'vacante' : 'ocupada' });
}
const perfilesH = torreH.map(() => 'puntual');
[5, 11, 17, 26, 33, 41].forEach(i => { perfilesH[i] = 'tardio'; });
[8, 22, 37, 45].forEach(i => { perfilesH[i] = 'moroso'; });
[2, 30].forEach(i => { perfilesH[i] = 'adelantado'; });
torreH.forEach((u, i) => { u.perfil = perfilesH[i]; });

const defH = {
  datos: { nombre: 'Residencial Horizonte', razon_social: 'Condominio Residencial Horizonte, A.C.', rfc: 'CRH1203154K2', direccion: 'Av. de los Insurgentes Sur 1840, Col. Florida, Álvaro Obregón', ciudad: 'Ciudad de México',
    dia_vencimiento: 10, dias_gracia: 5, tasa_recargo_bp: 200, pct_reserva_bp: 1000, umbral_aprobacion_cents: pesos(25000) },
  cuentaOp: '0712345601', cuentaRes: '0712345628', saldoOp: 412_600, saldoRes: 1_186_400, cuotaMensual: 186_000, unidades: torreH,
  extraordinaria: { mes: -8, concepto: 'Impermeabilización de azoteas Torres A y B', total: 182_400 },
  proveedores: [
    ['cfe', 'CFE Suministrador de Servicios Básicos', 'CSS160330CP7', 'Energía eléctrica'], ['agua', 'Sistema de Aguas de la Ciudad de México', 'SAC920101AB1', 'Agua potable'],
    ['gas', 'Gas Natural del Valle de México', 'GNV970512QX3', 'Gas'], ['seg', 'Seguridad Privada Centinela, S.A. de C.V.', 'SPC090304RT8', 'Vigilancia'],
    ['limp', 'Servicios de Limpieza Brillo Total', 'SLB150708JK1', 'Limpieza'], ['jard', 'Jardines y Áreas Verdes del Valle', 'JAV110215PL6', 'Jardinería'],
    ['elev', 'Elevadores y Ascensores del Centro', 'EAC080922MN4', 'Elevadores'], ['mant', 'Mantenimiento Integral Morales', 'MOMR780412HD2', 'Mantenimiento'],
    ['hidro', 'Hidroneumáticos y Bombas Aqua-Tec', 'HBA130606TR5', 'Equipos hidráulicos'], ['adm', 'MEDRATMOS Administración Condominal', 'MAC180101KL9', 'Administración'],
    ['cont', 'Despacho Contable Ríos y Asociados', 'DCR140320UV7', 'Contabilidad'], ['ase', 'Aseguradora Patrimonial del Centro', 'APC020815WX3', 'Seguros'],
    ['imper', 'Impermeabilizaciones Técnicas del Sur', 'ITS160911YZ8', 'Impermeabilización'], ['pap', 'Papelería y Oficina Central', 'POC190210AB2', 'Papelería'],
  ],
  gastos: [
    { cuenta: '5101', prov: 'cfe', concepto: 'Energía eléctrica áreas comunes', monto: 22_000, dia: 8 },
    { cuenta: '5102', prov: 'agua', concepto: 'Suministro de agua', monto: 9_500, dia: 12 },
    { cuenta: '5103', prov: 'gas', concepto: 'Gas calentadores comunes', monto: 2_800 },
    { cuenta: '5201', prov: 'seg', concepto: 'Servicio de vigilancia 24/7', monto: 52_000, fijo: true, dia: 4, pendiente: true },
    { cuenta: '5202', prov: 'limp', concepto: 'Servicio de limpieza', monto: 24_000, fijo: true, dia: 3 },
    { cuenta: '5203', prov: 'jard', concepto: 'Mantenimiento de jardines', monto: 7_500, fijo: true },
    { cuenta: '5301', prov: 'elev', concepto: 'Póliza de mantenimiento de elevadores', monto: 9_800, fijo: true, dia: 2 },
    { cuenta: '5302', prov: 'mant', concepto: 'Reparaciones menores y mantenimiento', monto: 8_000 },
    { cuenta: '5303', prov: 'hidro', concepto: 'Mantenimiento de bombas', monto: 3_500 },
    { cuenta: '5401', prov: 'adm', concepto: 'Honorarios de administración', monto: 18_000, fijo: true, dia: 1 },
    { cuenta: '5402', prov: 'cont', concepto: 'Honorarios contables', monto: 4_500, fijo: true, dia: 5 },
    { cuenta: '5501', prov: 'ase', concepto: 'Póliza anual de seguro del inmueble', monto: 36_400, fijo: true, meses: [2] },
    { cuenta: '5502', prov: null, concepto: 'Comisiones bancarias', monto: 650, domiciliado: true, dia: 28 },
    { cuenta: '5503', prov: 'pap', concepto: 'Papelería y consumibles', monto: 900 },
  ],
};
const H = crearCondo(defH);
defH.gastos.push({ cuenta: '5302', prov: 'imper', concepto: 'Impermeabilización (anticipo y finiquito)', monto: 91_200, fijo: true, meses: [+addMonths(ACTUAL, -7).slice(5, 7), +addMonths(ACTUAL, -6).slice(5, 7)] });
defH.gastos.push({ cuenta: '5303', prov: 'hidro', concepto: 'Reemplazo de bomba hidroneumática (fondo de reserva)', monto: 38_600, fijo: true, fondo: 'reserva', meses: [+addMonths(ACTUAL, -4).slice(5, 7)] });

tx(db, () => {
  for (const [u, rol] of [[admin, 'admin'], [contador, 'contador'], [comite, 'comite']]) db.prepare('INSERT INTO membresias (usuario_id, condominio_id, rol) VALUES (?,?,?)').run(u.id, H.cid, rol);
  db.prepare('INSERT INTO membresias (usuario_id, condominio_id, rol, persona_id) VALUES (?,?,?,?)').run(residenteU.id, H.cid, 'residente', H.unidades[0].persona);
  db.prepare("UPDATE personas SET nombre = 'Mariana Torres Salinas', email = 'residente@indiviso.test' WHERE id = ?").run(H.unidades[0].persona);
});
simular(defH, H, { contador, aprobador: comite });

// ===================== Torre Alameda =====================
const torreA = [];
for (let piso = 1; piso <= 8; piso++) for (let n = 1; n <= 2; n++) torreA.push({ clave: `${piso}0${n}`, torre: 'Torre única', m2: n === 1 ? 110 : 86, estado: rnd() < 0.2 ? 'renta' : 'ocupada', perfil: 'puntual' });
[3, 9].forEach(i => { torreA[i].perfil = 'tardio'; }); [6, 13].forEach(i => { torreA[i].perfil = 'moroso'; });
const defA = {
  datos: { nombre: 'Torre Alameda', razon_social: 'Condominio Torre Alameda, A.C.', rfc: 'CTA150922PQ1', direccion: 'Calz. de Tlalpan 2215, Col. Ciudad Jardín, Coyoacán', ciudad: 'Ciudad de México',
    dia_vencimiento: 5, dias_gracia: 3, tasa_recargo_bp: 300, pct_reserva_bp: 800, umbral_aprobacion_cents: pesos(15000) },
  cuentaOp: '0798765410', saldoOp: 96_300, saldoRes: 0, cuotaMensual: 58_400, unidades: torreA,
  proveedores: [['cfe', 'CFE Suministrador de Servicios Básicos', 'CSS160330CP7', 'Energía eléctrica'], ['seg', 'Vigilancia Alfa Protección', 'VAP120517CD3', 'Vigilancia'],
    ['limp', 'Limpieza Express del Sur', 'LES170303EF4', 'Limpieza'], ['elev', 'Elevadores y Ascensores del Centro', 'EAC080922MN4', 'Elevadores'], ['adm', 'MEDRATMOS Administración Condominal', 'MAC180101KL9', 'Administración']],
  gastos: [
    { cuenta: '5101', prov: 'cfe', concepto: 'Energía eléctrica áreas comunes', monto: 6_200, dia: 9 },
    { cuenta: '5201', prov: 'seg', concepto: 'Vigilancia nocturna', monto: 22_000, fijo: true, dia: 3 },
    { cuenta: '5202', prov: 'limp', concepto: 'Servicio de limpieza', monto: 9_000, fijo: true, dia: 3 },
    { cuenta: '5301', prov: 'elev', concepto: 'Mantenimiento de elevador', monto: 4_200, fijo: true, dia: 2 },
    { cuenta: '5401', prov: 'adm', concepto: 'Honorarios de administración', monto: 8_000, fijo: true, dia: 1 },
    { cuenta: '5502', prov: null, concepto: 'Comisiones bancarias', monto: 420, domiciliado: true, dia: 28 },
  ],
};
const A = crearCondo(defA);
tx(db, () => { for (const [u, rol] of [[admin, 'admin'], [contador, 'contador']]) db.prepare('INSERT INTO membresias (usuario_id, condominio_id, rol) VALUES (?,?,?)').run(u.id, A.cid, rol); });
simular(defA, A, { contador, aprobador: admin });

// ===================== Presupuestos, convenio, gestiones, pendientes =====================
const anio = +HOY.slice(0, 4);
for (const [C, def, acta] of [[H, defH, `Asamblea ordinaria del 06/12/${anio - 1}, acta 14`], [A, defA, `Asamblea ordinaria del 29/11/${anio - 1}, acta 9`]]) {
  tx(db, () => {
    const pid = F.nuevaVersionPresupuesto(db, C.cid, anio, contador);
    const lineas = [];
    for (const g of def.gastos) for (let m = 1; m <= 12; m++) {
      if (g.meses && !g.meses.includes(m)) continue;
      if (g.fondo === 'reserva' || g.prov === 'imper') continue;
      lineas.push({ cuenta_id: cuentaPorCodigo(C.cid, g.cuenta), mes: m, monto_cents: Math.round(pesos(g.monto * 1.02) / 100) * 100 });
    }
    const agg = new Map(); for (const l of lineas) { const k = `${l.cuenta_id}:${l.mes}`; agg.set(k, { ...l, monto_cents: (agg.get(k)?.monto_cents || 0) + l.monto_cents }); }
    F.guardarLineasPresupuesto(db, C.cid, pid, [...agg.values()]);
    F.aprobarPresupuesto(db, C.cid, pid, acta, admin);
    F.nuevaVersionPresupuesto(db, C.cid, anio + 1, contador);
  });
}

tx(db, () => {
  const moroso = H.unidades.find(u => u.perfil === 'moroso');
  F.crearConvenio(db, H.cid, { unidad_id: moroso.id, parcialidades: 6, fecha: `${addMonths(ACTUAL, -3)}-15`, condonar_recargos: true, notas: 'Convenio firmado ante el comité de vigilancia' }, admin);
  for (const u of H.unidades.filter(x => x.perfil !== 'puntual' && x.perfil !== 'adelantado')) {
    db.prepare('INSERT INTO gestiones (condominio_id, unidad_id, tipo, nota, promesa_fecha, promesa_cents, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(H.cid, u.id, pick(['llamada', 'correo', 'whatsapp']), pick(['Se envió recordatorio de saldo vencido.', 'Indica que pagará en la próxima quincena.', 'No contestó; se dejó mensaje.']), u.perfil === 'tardio' ? addDays(HOY, ri(3, 12)) : null, u.perfil === 'tardio' ? u.cuota * 2 : null, contador.id, Date.now() - ri(1, 20) * 86400000);
  }
});

// Módulos de finanzas adicionales (mismo motor que la operación normal)
tx(db, () => {
  const ahora = Date.now();
  // Pronto pago: 3% a quien liquida a más tardar el día 5
  db.prepare('UPDATE condominios SET pronto_pago_bp = 300, pronto_pago_dia = 5 WHERE id = ?').run(H.cid);
  // Adeudos recurrentes: cajones adicionales y mantenimiento mayor de elevadores en 6 mensualidades
  for (const u of H.unidades.slice(2, 5)) F.crearCargoRecurrente(db, H.cid, { unidad_id: u.id, tipo: 'otro', concepto: 'Renta de cajón adicional', monto_cents: pesos(450), desde: ACTUAL }, admin);
  F.crearCargoRecurrente(db, H.cid, { unidad_id: null, tipo: 'extraordinaria', concepto: 'Modernización de elevadores (6 mensualidades)', monto_cents: pesos(180), desde: ACTUAL, hasta: addMonths(ACTUAL, 5) }, admin);
  F.emitirCuotas(db, H.cid, ACTUAL, admin);
  // Fondo específico: pintura de fachadas, alimentado por una extraordinaria y con un anticipo pagado
  const fondo = F.crearFondo(db, H.cid, { nombre: 'Pintura de fachadas', meta_cents: pesos(600000), descripcion: 'Aprobado en asamblea extraordinaria' }, admin);
  F.emitirExtraordinaria(db, H.cid, { concepto: 'Aportación fondo de pintura de fachadas', total_cents: pesos(240000), metodo: 'indiviso', destino: 'fondo', fondo_id: fondo, fecha: `${addMonths(ACTUAL, -1)}-05`, vencimiento: `${addMonths(ACTUAL, 1)}-10` }, admin);
  // Unidades puntuales liquidan todo a más tardar el día 5 (reciben el descuento por pronto pago de su cuota del mes)
  const limite = `${ACTUAL}-05` < HOY ? `${ACTUAL}-05` : HOY;
  for (const u of H.unidades.filter(x => x.perfil === 'puntual').slice(0, 26)) {
    const ab = F.cargosAbiertos(db, u.id);
    if (!ab.some(x => x.concepto.includes('pintura'))) continue;
    const desc = ab.filter(x => x.tipo === 'ordinaria' && x.saldo_cents === x.monto_cents && x.periodo === ACTUAL).reduce((t, x) => t + Math.round(x.monto_cents * 300 / 10000), 0);
    const debe = ab.reduce((t, x) => t + x.saldo_cents, 0) - desc;
    F.registrarPago(db, H.cid, { unidad_id: u.id, fecha: limite, monto_cents: debe, metodo: 'transferencia', referencia: `PINT${ri(1000000, 9999999)}${u.id}`, cuenta_banco_id: H.bOp, idem_key: `seed-pint-${u.id}`, confirmar_duplicado: true }, contador);
  }
  const prov = Number(db.prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, telefono, created_at) VALUES (?,?,?,?,?,?)').run(H.cid, 'Pinturas y Recubrimientos del Caribe', 'PRC1903125T4', 'Pintura e impermeabilización', '998 210 4455', ahora).lastInsertRowid);
  const mant = db.prepare("SELECT id FROM cuentas WHERE condominio_id = ? AND codigo = '5302'").get(H.cid).id;
  const eg = F.crearEgreso(db, H.cid, { proveedor_id: prov, cuenta_id: mant, fondo: 'reserva', fondo_id: fondo, fecha: `${addMonths(ACTUAL, -1)}-26`, concepto: 'Anticipo 30% pintura de fachadas torres A y B', subtotal_cents: pesos(62068.97), iva_cents: pesos(9931.03), retenciones_cents: 0, factura_folio: 'A-2291', idem_key: 'seed-eg-pintura' }, contador);
  F.aprobarEgreso(db, H.cid, eg.id, true, null, comite);
  F.pagarEgreso(db, H.cid, eg.id, { fecha_pago: `${addMonths(ACTUAL, -1)}-28`, metodo: 'transferencia', cuenta_banco_id: H.bOp, referencia: 'SPEI 8812' }, contador);

});

// Cierre de los meses ya revisados (hasta dos meses atrás)
for (const C of [H, A]) {
  const primero = db.prepare('SELECT MIN(periodo) p FROM periodos WHERE condominio_id = ?').get(C.cid).p;
  for (let p = primero; p <= addMonths(ACTUAL, -2); p = addMonths(p, 1)) tx(db, () => F.cerrarPeriodo(db, C.cid, p, admin));
}
tx(db, () => audit(db, { usuario_id: superU.id, accion: 'datos_demo_generados' }));

guardarCreds();
console.log('Demo generada: Residencial Horizonte (48 unidades) y Torre Alameda (16 unidades).');
