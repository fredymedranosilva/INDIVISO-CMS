// Importación desde Excel: plantilla con catálogos, lectura del archivo (o celdas pegadas),
// vista previa validada por el servidor fila por fila y aplicación de las filas correctas.
import { S, capi, html, raw, mount, $, pesos, puede, tabla, toast, dialogo, hoy, addMonths, periodoActual } from '../ui.js';
import { leerTabla, leerTexto, escribirXlsx, guardarBlob } from '../xlsx.js';
import { invalidar } from './comun.js';
import { refrescarContadores } from '../app.js';

const finMesAnterior = () => { const p = addMonths(periodoActual(), -1); const [y, m] = p.split('-').map(Number); return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const OCUP = { ocupada: 'Ocupada', vacante: 'Vacante', renta: 'En renta' };
const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const COLUMNA = { unidad: 'Unidad', torre: 'Torre', fecha: 'Fecha', importe: 'Importe', metodo: 'Forma de pago', cuenta: 'Cuenta', referencia: 'Referencia', notas: 'Comentarios',
  concepto: 'Concepto', proveedor: 'Proveedor', rfc: 'RFC', subtotal: 'Subtotal', iva: 'IVA', retenciones: 'Retenciones', partida: 'Partida', fondo: 'Fondo', fecha_pago: 'Fecha de pago',
  factura: 'Folio factura', uuid: 'UUID', comentarios: 'Comentarios', nombre: 'Nombre', giro: 'Giro', email: 'Correo', telefono: 'Teléfono', clabe: 'CLABE', tipo: 'Tipo', superficie: 'm²',
  indiviso: 'Indiviso', cuota: 'Cuota', estado: 'Ocupación', activa: 'Activa', propietario: 'Propietario', inquilino: 'Inquilino', email_inq: 'Correo inquilino', tel_inq: 'Teléfono inquilino',
  saldo: 'Saldo', adeudo: 'Adeudo', favor: 'Saldo a favor', anual: 'Anual', mensual: 'Mensual', ...Object.fromEntries(MES.map((m, i) => [`m${i + 1}`, m])) };

const FORMAS = [['Transferencia', '03'], ['Efectivo', '01'], ['Cheque', '02'], ['Tarjeta', '04 / 28'], ['Depósito', ''], ['Domiciliación', '']];
const hojaUnidades = c => ({ nombre: 'Unidades', filas: [['Clave', 'Torre', 'Propietario', 'Referencia de pago'], ...c.unidades.filter(u => u.activo).map(u => [u.clave, u.torre || '', u.propietario || '', u.referencia])] });
const hojaCuentas = c => ({ nombre: 'Cuentas', filas: [['Código', 'Cuenta', 'Número', 'Fondo'], ...c.bancos.map(b => [b.codigo, b.nombre, b.numero || '', b.fondo === 'reserva' ? 'Reserva' : 'Operación']), ['Caja', 'Efectivo en caja', '', '']] });
const hojaFormas = () => ({ nombre: 'Formas de pago', filas: [['Forma de pago', 'Clave SAT (también se acepta)'], ...FORMAS] });
const hojaPartidas = c => ({ nombre: 'Partidas', filas: [['Código', 'Partida'], ...c.partidas.map(p => [p.codigo, p.nombre])] });
const instrucciones = lineas => ({ nombre: 'Instrucciones', anchos: [110], filas: [['Cómo llenar la plantilla'], ...lineas.map(l => [l])] });
// Tres filas de ejemplo (en amarillo, marcadas «EJEMPLO · borre esta fila»): muestran cómo capturar y nunca se importan.
const MARCA = 'EJEMPLO · borre esta fila';
const hojaConEjemplos = (nombre, enc, ejemplos, resto = []) => ({ nombre, filas: [enc, ...ejemplos, ...resto], ejemplos: ejemplos.map((_, i) => i + 1) });
const dmy = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const diasAtras = n => { const d = new Date(); d.setDate(d.getDate() - n); return dmy(d); };
const COMUNES = ['• Las 3 filas en amarillo son EJEMPLOS: muestran cómo capturar y NO se importan. Puede borrarlas o escribir sus datos debajo.',
  '• Llene la primera hoja. No cambie los encabezados; puede borrar columnas opcionales o cambiar su orden.',
  '• Fechas en DD/MM/AAAA (o como fecha de Excel). Importes con o sin signo de pesos y comas: 3,450.00',
  '• Antes de guardar nada verá una vista previa con los errores de cada fila. Las filas con error no se importan.',
  '• Importar dos veces el mismo archivo no duplica registros.'];

// Cada tipo: texto, plantilla, opciones del diálogo y cómo se leen.
const DEF = {
  pagos: {
    titulo: 'Importar pagos desde Excel', archivo: 'plantilla-pagos',
    ayuda: 'Cada fila es un pago recibido: se aplica a los cargos más antiguos de la unidad, se emite su recibo y un excedente queda como saldo a favor (igual que al capturarlo a mano).',
    plantilla: c => {
      const us = c.unidades.filter(u => u.activo), b = c.bancos[0]?.codigo || 'Caja';
      const ej = us.slice(0, 3).map((u, i) => [u.clave, u.propietario || '', [3450, 1800, 5000][i], diasAtras(3 - i), ['Transferencia', 'Depósito', 'Efectivo'][i], i === 2 ? 'Caja' : b, ['SPEI 0012345678', 'FOLIO 445566', ''][i], `${MARCA}${i === 1 ? ' · pago parcial' : i === 2 ? ' · en efectivo va a Caja' : ''}`]);
      return [hojaConEjemplos('Pagos', ['Vivienda', 'Propietario', 'Importe', 'Fecha', 'Forma de pago', 'Cuenta bancaria', 'Referencia', 'Comentarios'], ej, us.map(u => [u.clave, u.propietario || ''])),
      instrucciones([...COMUNES, '• La hoja trae todas las viviendas: llene Importe y Fecha solo en las que pagaron; las filas sin importe se ignoran.',
        '• Vivienda: clave o referencia de pago (hoja Unidades); la columna Propietario es solo de consulta. Cuenta bancaria: código de la hoja Cuentas, últimos 4 dígitos, nombre o «Caja».',
        '• Forma de pago: Transferencia, Efectivo, Cheque, Tarjeta, Depósito o Domiciliación (también la clave SAT: 01, 02, 03, 04, 28).',
        '• Referencia: clave de rastreo o folio de la operación; evita registrar dos veces el mismo depósito.']),
      hojaUnidades(c), hojaCuentas(c), hojaFormas()];
    },
    opciones: c => html`<div class="form-grid">
      <label class="field"><span>Cuenta para filas sin cuenta</span><select name="cuenta_banco_id"><option value="">Ninguna (indicar en cada fila)</option>${c.bancos.map(b => html`<option value="${b.id}" ${b.fondo === 'operacion' && c.bancos.filter(x => x.fondo === 'operacion').length === 1 ? raw('selected') : ''}>${b.codigo} · ${b.nombre}</option>`)}</select></label>
      <label class="check"><input type="checkbox" name="confirmar_duplicados"><span>Importar aunque exista un pago de la misma unidad e importe en ±3 días</span></label></div>`,
    leer: f => ({ cuenta_banco_id: f.cuenta_banco_id.value ? +f.cuenta_banco_id.value : null, confirmar_duplicados: f.confirmar_duplicados.checked }),
  },
  egresos: {
    titulo: 'Importar egresos desde Excel', archivo: 'plantilla-egresos',
    ayuda: 'Mismas columnas que la plantilla de Vivook. Cada fila es un gasto: si trae forma de pago o cuenta bancaria queda pagado; los del fondo de reserva o de importe igual o mayor al umbral quedan pendientes de aprobación por otro usuario.',
    plantilla: c => {
      const part = re => c.partidas.find(p => re.test(p.nombre)) || c.partidas[0] || { codigo: '', nombre: '' };
      const pv = (re, def) => c.proveedores.find(p => re.test(p.nombre))?.nombre || def;
      const b = c.bancos[0]?.codigo || 'Caja', etiqueta = p => `${p.codigo} · ${p.nombre}`;
      const ej = [
        ['1ra quincena de vigilancia', pv(/vigil|segur/i, 'Seguridad Privada del Norte'), 15650, diasAtras(5), 'Transferencia', b, 'SPEI 0099887766', etiqueta(part(/vigil|segur/i)), 'Operación', MARCA],
        ['Recibo de luz de áreas comunes', pv(/cfe|luz|electric/i, 'CFE'), 2563.5, diasAtras(4), 'Transferencia', b, 'CFE 123456789', etiqueta(part(/el[eé]ctric|luz|energ/i)), 'Operación', MARCA],
        ['Reparación de bomba de agua', pv(/bomba|hidr/i, 'Hidráulica del Centro'), 1200, diasAtras(2), 'Efectivo', 'Caja', '', etiqueta(part(/bomba|hidr/i)), 'Operación', `${MARCA} · pagado en efectivo`],
      ];
      return [hojaConEjemplos('Egresos', ['Concepto', 'Proveedor', 'Importe', 'Fecha', 'Forma de pago', 'Cuenta bancaria', 'Referencia', 'Clasificación presupuestal', 'Fondo', 'Comentarios'], ej),
        instrucciones([...COMUNES, '• Importe: total pagado en pesos.',
          '• Clasificación presupuestal: código o nombre de la hoja Partidas. Fondo: Operación (ordinario), Reserva (extraordinario) o el nombre de un fondo (hoja Fondos).',
          '• Proveedor: si no existe en el catálogo se da de alta con su nombre.',
          '• Si la fila trae Forma de pago o Cuenta bancaria, el egreso queda pagado en esa fecha. Cuenta bancaria: código de la hoja Cuentas o «Caja».',
          '• Los egresos del fondo de reserva o de importe igual o mayor al umbral quedan pendientes de aprobación de un segundo usuario.']),
        hojaPartidas(c), hojaCuentas(c), hojaFormas(), { nombre: 'Fondos', filas: [['Fondo'], ['Operación'], ['Reserva'], ...(c.fondos || []).map(f => [f])] }, { nombre: 'Proveedores', filas: [['Nombre'], ...c.proveedores.map(p => [p.nombre])] }];
    },
    opciones: c => html`<div class="form-grid">
      <label class="field"><span>Partida para filas sin partida</span><select name="partida_id"><option value="">Ninguna (indicar en cada fila)</option>${c.partidas.map(p => html`<option value="${p.id}">${p.codigo} · ${p.nombre}</option>`)}</select></label>
      <label class="field"><span>Cuenta de pago para filas sin cuenta</span><select name="cuenta_banco_id"><option value="">Ninguna</option>${c.bancos.map(b => html`<option value="${b.id}">${b.codigo} · ${b.nombre}</option>`)}</select></label>
      <label class="check full"><input type="checkbox" name="registrar_pago"><span>Registrar todos como pagados (los que no requieren aprobación)</span></label>
      ${puede('config') ? html`<label class="check full"><input type="checkbox" name="crear_partidas"><span>Crear las partidas que no existan en el catálogo</span></label>` : ''}</div>`,
    leer: f => ({ partida_id: f.partida_id.value ? +f.partida_id.value : null, cuenta_banco_id: f.cuenta_banco_id.value ? +f.cuenta_banco_id.value : null, registrar_pago: f.registrar_pago.checked, crear_partidas: !!f.crear_partidas?.checked }),
  },
  proveedores: {
    titulo: 'Importar proveedores', archivo: 'proveedores',
    ayuda: 'Da de alta proveedores nuevos y completa los datos de contacto de los existentes (se identifican por RFC o nombre).',
    plantilla: c => [hojaConEjemplos('Proveedores', ['Nombre', 'RFC', 'Giro', 'Correo', 'Teléfono', 'CLABE', 'Comentarios'], [
      ['Seguridad Privada del Norte SA de CV', 'SPN010101AB1', 'Vigilancia', 'contacto@seguridadnorte.mx', '8112345678', '', MARCA],
      ['Jardinería Los Pinos', '', 'Jardinería', '', '8187654321', '', MARCA],
      ['Elevadores del Bajío', 'EBA990202CD2', 'Mantenimiento de elevadores', 'servicio@elevadoresbajio.mx', '', '012345678901234567', MARCA]],
      c.proveedores.map(p => [p.nombre, p.rfc || '', p.giro || '', p.email || '', p.telefono || ''])),
      instrucciones([...COMUNES, '• La CLABE (18 dígitos) se guarda enmascarada: solo los últimos 4 dígitos.'])],
  },
  directorio: {
    titulo: 'Importar directorio (unidades y residentes)', archivo: 'directorio',
    ayuda: 'Crea las unidades que no existen y actualiza las existentes con las columnas que traiga el archivo (las celdas vacías no borran datos). Vincula propietarios e inquilinos.',
    plantilla: c => [
      hojaConEjemplos('Directorio', ['Clave', 'Torre', 'Tipo', 'm2', 'Indiviso %', 'Cuota mensual', 'Ocupación', 'Activa', 'Propietario', 'Correo', 'Teléfono', 'RFC', 'Inquilino', 'Correo inquilino', 'Teléfono inquilino', 'Notas'], [
        ['101', 'Torre 1', 'departamento', 85, 1.25, 2676.2, 'Ocupada', 'Sí', 'Karla Fernández', 'karla@correo.com', '8112345678', '', '', '', '', MARCA],
        ['102', 'Torre 1', 'departamento', 92, 1.3542, 2899.5, 'En renta', 'Sí', 'Luis Pérez', 'luis@correo.com', '', '', 'Ana Ruiz', 'ana@correo.com', '8187654321', MARCA],
        ['L-1', '', 'local', 40, 0.6, 1300, 'Vacante', 'Sí', 'Inmobiliaria Centro SA', '', '', 'ICE010101AB1', '', '', '', MARCA]],
        c.unidades.map(u => [u.clave, u.torre || '', u.tipo, u.m2 ?? '', +(u.indiviso_ppm / 10000).toFixed(4), u.cuota_cents / 100, OCUP[u.estado], u.activo ? 'Sí' : 'No', u.propietario || '', u.email || '', u.telefono || '', u.rfc || '', u.inquilino || '', u.email_inq || '', u.tel_inq || '', u.notas || ''])),
      instrucciones([...COMUNES, '• Clave: identificador único de la unidad. Si usa Torre + número (p. ej. «Torre 1» y «101»), la unidad nueva se crea como «1-101».',
        '• Indiviso en porcentaje con 4 decimales (la suma de todas las unidades debe dar 100%). Cuota: cuota ordinaria mensual.',
        '• Ocupación: Ocupada, Vacante o En renta. Activa: Sí o No (las inactivas no generan cuotas).',
        '• Tipo: departamento, casa, local, oficina, bodega o estacionamiento.',
        '• Un propietario o inquilino con otro nombre se agrega a la unidad; para quitar a alguien use la ficha de la unidad.'])],
  },
  saldos: {
    titulo: 'Saldos iniciales por unidad', archivo: 'saldos-iniciales',
    ayuda: 'Para empezar a operar con los saldos que traía cada unidad en el sistema anterior. Un saldo positivo es adeudo; uno negativo (o con «A favor») es saldo a favor. Se registra contra «Remanente de ejercicios anteriores», no como ingreso del año. Solo se registra uno por unidad.',
    plantilla: c => [
      hojaConEjemplos('Saldos', ['Unidad', 'Propietario', 'Saldo', 'Concepto'], (() => { const us = c.unidades.filter(u => u.activo).slice(0, 3); return [
        [us[0]?.clave || '101', us[0]?.propietario || '', 7250, `${MARCA} · adeudo de 2 cuotas`], [us[1]?.clave || '102', us[1]?.propietario || '', -1200, `${MARCA} · saldo a favor (negativo)`], [us[2]?.clave || '103', us[2]?.propietario || '', 0, `${MARCA} · al corriente`]]; })(),
        c.unidades.filter(u => u.activo).map(u => [u.clave, u.propietario || ''])),
      instrucciones([...COMUNES, '• Saldo: positivo = adeudo de la unidad; negativo o «1,200.00 (A favor)» = saldo a favor. Deje vacío o en 0 si está al corriente.',
        '• El adeudo inicial vence en la fecha de corte (cuenta como vencido) y no genera recargos.']), hojaUnidades(c)],
    opciones: () => html`<div class="form-grid"><label class="field"><span>Fecha de corte de los saldos</span><input type="date" name="fecha_corte" value="${finMesAnterior()}" max="${hoy()}" required></label>
      <p class="note">Use el último día antes de empezar a registrar en Indiviso. El periodo de esa fecha no debe estar cerrado.</p></div>`,
    leer: f => ({ fecha_corte: f.fecha_corte.value }),
  },
  presupuesto: {
    titulo: 'Importar presupuesto desde Excel', archivo: 'presupuesto',
    ayuda: 'Cada fila es una partida con su importe por mes. Si solo trae una columna «Anual» se reparte en 12 meses iguales (sin perder centavos). Las partidas que no vienen en el archivo no se modifican.',
    plantilla: (c, x) => [
      hojaConEjemplos('Presupuesto', ['Código', 'Partida', ...MES, 'Comentarios'], [
        ['EJEMPLO', 'Vigilancia (mismo importe cada mes)', ...MES.map(() => 31300), MARCA],
        ['EJEMPLO', 'Mantenimiento de elevadores (trimestral)', ...MES.map((_, i) => i % 3 === 0 ? 9800 : 0), MARCA],
        ['EJEMPLO', 'Pintura (solo en abril)', ...MES.map((_, i) => i === 3 ? 45000 : 0), MARCA]],
        c.partidas.map(p => [p.codigo, p.nombre, ...MES.map((_, i) => (x.valores.get(`${p.id}:${i + 1}`) || 0) / 100)])),
      instrucciones([...COMUNES, '• Código: el de la partida (hoja Partidas). Importes por mes en pesos.', '• En lugar de los 12 meses puede usar una sola columna «Anual» o «Mensual».']), hojaPartidas(c)],
    opciones: () => puede('config') ? html`<label class="check"><input type="checkbox" name="crear_partidas"><span>Crear las partidas que no existan en el catálogo</span></label>` : '',
    leer: f => ({ crear_partidas: !!f.crear_partidas?.checked }),
  },
};

export async function descargarPlantilla(tipo, extra = {}) {
  const d = DEF[tipo], c = await capi('/importar/catalogos');
  const nombre = (S.condos.find(x => x.id === S.cid)?.nombre || 'condominio').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').toLowerCase();
  await guardarBlob(escribirXlsx(d.plantilla(c, extra)), `${d.archivo}-${nombre}.xlsx`);
}

// abrirImportacion('pagos', { onOk, opciones: { presupuesto_id }, extra })
export async function abrirImportacion(tipo, { onOk, opciones: fijas = {}, extra = {} } = {}) {
  const d = DEF[tipo];
  const cat = await capi('/importar/catalogos');
  let filas = null, archivo = null, res = null, pendiente = 0;
  dialogo({
    titulo: d.titulo, ancho: 'wide',
    cuerpo: html`<p class="lead small">${d.ayuda}</p>
      <div class="imp-pasos">
        <div class="imp-paso"><b>1</b><span>Descargue la plantilla, llénela en Excel y guárdela.</span><button type="button" class="btn sm" data-plantilla>Descargar plantilla .xlsx</button></div>
        <div class="imp-paso"><b>2</b><label class="field grow"><span>Seleccione el archivo (.xlsx o .csv)</span><input type="file" name="archivo" accept=".xlsx,.xlsm,.csv,.txt,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></label></div>
        <details class="imp-pegar"><summary>O pegue aquí las celdas copiadas de Excel (con encabezados)</summary>
          <textarea name="pegado" rows="5" placeholder="Copie en Excel el rango con encabezados y péguelo aquí"></textarea>
          <button type="button" class="btn sm top-gap" data-pegar>Revisar celdas pegadas</button></details>
      </div>
      ${d.opciones ? d.opciones(cat) : ''}
      <div data-res aria-live="polite"></div>`,
    acciones: [{ label: 'Cancelar', value: 'cancel' }, { label: 'Importar', primary: true, value: 'ok' }],
    onOpen: (dlg, f) => {
      const caja = $('[data-res]', dlg), btn = $('.dlg-foot .primary', dlg);
      btn.disabled = true;
      const opciones = () => ({ ...(d.leer ? d.leer(f) : {}), ...fijas });
      const validar = async () => {
        if (!filas) return;
        const yo = ++pendiente;
        btn.disabled = true;
        mount(caja, html`<p class="note">Revisando ${filas.length} filas…</p>`);
        try {
          const r = await capi(`/importar/${tipo}`, { method: 'POST', body: { filas, aplicar: false, opciones: opciones(), archivo } });
          if (yo !== pendiente) return;
          res = r; pintar(caja, r, filas, archivo); btn.disabled = !r.resumen.validas;
          btn.textContent = r.resumen.validas ? `Importar ${r.resumen.validas} ${r.resumen.validas === 1 ? 'fila' : 'filas'}` : 'Importar';
        } catch (e) { if (yo === pendiente) { res = null; mount(caja, html`<p class="note neg">${e.message}</p>`); } }
      };
      $('[data-plantilla]', dlg).addEventListener('click', () => descargarPlantilla(tipo, extra).catch(e => toast(e.message, 'error')));
      f.archivo.addEventListener('change', async () => {
        const file = f.archivo.files[0]; if (!file) return;
        try {
          if (file.size > 6 * 1024 * 1024) throw new Error('El archivo excede 6 MB; divídalo en partes.');
          filas = recortar(await leerTabla(file)); archivo = file.name; await validar();
        } catch (e) { filas = null; res = null; btn.disabled = true; mount(caja, html`<p class="note neg">${e.message}</p>`); }
      });
      $('[data-pegar]', dlg).addEventListener('click', async () => {
        const t = f.pegado.value; if (!t.trim()) return;
        filas = recortar(leerTexto(t)); archivo = 'celdas pegadas'; await validar();
      });
      for (const el of f.querySelectorAll('select, input[type=checkbox], input[type=date]')) el.addEventListener('change', validar);
      f._opciones = opciones;
    },
    onSubmit: async f => {
      if (!filas || !res?.resumen.validas) throw new Error('Seleccione un archivo con filas válidas.');
      const r = await capi(`/importar/${tipo}`, { method: 'POST', body: { filas, aplicar: true, opciones: f._opciones(), archivo } });
      if (!r.aplicado) throw new Error('No se importó ninguna fila: revise los errores.');
      invalidar(); refrescarContadores();
      const s = r.resumen;
      toast(`Importación terminada: ${s.validas} ${s.validas === 1 ? 'fila' : 'filas'}${s.omitidas ? ` · ${s.omitidas} ya existían` : ''}${s.errores ? ` · ${s.errores} con error (no se importaron)` : ''}`);
      onOk?.(r);
    },
  });
}

// Quita filas y columnas vacías del final; limita el tamaño enviado.
function recortar(filas) {
  const f = filas.map(r => { const x = [...r]; while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop(); return x; });
  while (f.length && !f[f.length - 1].length) f.pop();
  if (!f.length) throw new Error('El archivo está vacío.');
  if (f.length > 5001) throw new Error(`El archivo tiene ${f.length - 1} filas; el máximo por importación es 5,000. Divídalo en partes.`);
  return f;
}

function pintar(el, r, filas, archivo) {
  const s = r.resumen, errores = r.filas.filter(x => !x.ok), buenas = r.filas.filter(x => x.ok);
  mount(el, html`
    <div class="imp-resumen">
      <div><span>Filas leídas</span><b>${s.filas}</b></div>
      <div class="pos-t"><span>Se importarán</span><b>${s.validas}</b></div>
      <div><span>Ya existían / sin cambios</span><b>${s.omitidas}</b></div>
      <div class="${s.errores ? 'neg-t' : ''}"><span>Con error</span><b>${s.errores}</b></div>
      ${s.total_cents ? html`<div><span>Importe</span><b>${pesos(s.total_cents)}</b></div>` : ''}
    </div>
    ${s.ejemplos ? html`<p class="note">Se ignoraron ${s.ejemplos} ${s.ejemplos === 1 ? 'fila' : 'filas'} de ejemplo de la plantilla.</p>` : ''}
    <p class="small muted">Encabezados en la fila ${r.encabezado}. Columnas reconocidas: ${Object.entries(r.columnas).map(([k, h]) => html`<span class="pill neutral" title="${h}">${COLUMNA[k] || k}</span> `)}
      ${r.ignoradas.length ? html`<br>No se usan: ${r.ignoradas.join(', ')}.` : ''}</p>
    ${s.partidas_nuevas?.length ? html`<p class="note warn">Se crearán ${s.partidas_nuevas.length} partidas nuevas: ${s.partidas_nuevas.slice(0, 8).join(' · ')}${s.partidas_nuevas.length > 8 ? '…' : ''}</p>` : ''}
    ${s.proveedores_nuevos?.length ? html`<p class="note">Se darán de alta ${s.proveedores_nuevos.length} proveedores: ${s.proveedores_nuevos.slice(0, 8).join(' · ')}${s.proveedores_nuevos.length > 8 ? '…' : ''}</p>` : ''}
    ${errores.length ? html`<div class="imp-head"><h3>Filas con error · no se importarán</h3><button type="button" class="link" data-errores>Descargar errores para corregir</button></div>
      ${tabla([{ t: 'Fila', k: x => x.n, cls: 'nowrap' }, { t: 'Error', k: x => x.error }], errores.slice(0, 200))}${errores.length > 200 ? html`<p class="small muted">… y ${errores.length - 200} más en el archivo de errores.</p>` : ''}` : ''}
    ${buenas.length ? html`<h3>Vista previa</h3>${tabla([{ t: 'Fila', k: x => x.n, cls: 'nowrap' }, { t: '', k: x => html`<span class="pill ${x.accion === 'omitido' ? 'neutral' : x.accion === 'actualizado' ? 'warn' : 'pos'}">${x.accion === 'creado' ? 'nuevo' : x.accion === 'actualizado' ? 'actualiza' : 'sin cambio'}</span>` }, { t: 'Resultado', k: x => x.detalle }], buenas.slice(0, 60))}${buenas.length > 60 ? html`<p class="small muted">… y ${buenas.length - 60} filas más.</p>` : ''}` : ''}`);
  el.querySelector('[data-errores]')?.addEventListener('click', () => {
    const enc = filas[r.encabezado - 1] || [];
    const mal = new Map(errores.map(x => [x.n, x.error]));
    guardarBlob(escribirXlsx([{ nombre: 'Errores', filas: [[...enc, 'Error'], ...filas.map((f, i) => [i + 1, f]).filter(([n]) => mal.has(n)).map(([n, f]) => [...enc.map((_, j) => f[j] ?? ''), mal.get(n)])] }]),
      `errores-${String(archivo || 'importacion').replace(/\.\w+$/, '')}.xlsx`);
  });
}

