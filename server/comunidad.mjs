// Comunidad: avisos, calendario, documentos, teléfonos útiles, cosas perdidas y encuestas.
// La administración y el comité publican; los residentes consultan lo público y votan (un voto por unidad).
import { fail, v, hoy } from './util.mjs';

const TIPOS = ['aviso', 'evento', 'documento', 'telefono', 'perdido'];
const CAMPOS = { titulo: 'str|max160', cuerpo: 'str|opt|max4000', categoria: 'str|opt|max60', fecha: 'date|opt', hora: 'str|opt|max5', lugar: 'str|opt|max120',
  telefono: 'str|opt|max40', archivo_id: 'int|opt', fijado: 'bool|opt', publico: 'bool|opt', estado: 'enum|vigente|archivado|entregado|opt' };

export function resultadosEncuesta(db, e) {
  const ops = db.prepare('SELECT id, texto, orden FROM encuesta_opciones WHERE encuesta_id = ? ORDER BY orden').all(e.id);
  const votos = db.prepare('SELECT v.opcion_id, COUNT(*) n, SUM(u.indiviso_ppm) ind FROM encuesta_votos v JOIN unidades u ON u.id = v.unidad_id WHERE v.encuesta_id = ? GROUP BY v.opcion_id').all(e.id);
  const total = db.prepare('SELECT COUNT(*) n FROM unidades WHERE condominio_id = ? AND activo = 1').get(e.condominio_id).n;
  const m = new Map(votos.map(x => [x.opcion_id, x]));
  const emitidos = votos.reduce((a, x) => a + x.n, 0);
  const indVot = votos.reduce((a, x) => a + (x.ind || 0), 0);
  return {
    opciones: ops.map(o => ({ ...o, votos: m.get(o.id)?.n || 0, indiviso_ppm: m.get(o.id)?.ind || 0 })),
    emitidos, unidades: total, participacion: total ? emitidos / total : 0, indiviso_votado_ppm: indVot,
  };
}

export function rutasComunidad({ C, PERMS, escribir, exigir, idParam, q, unidadesDeResidente }) {
  const puedePublicar = ctx => PERMS.comunicar.includes(ctx.rol);
  const lectura = ctx => { if (ctx.rol !== 'residente') exigir(ctx, 'ver'); };
  const encuestaDe = (ctx, id) => ctx.db.prepare('SELECT * FROM encuestas WHERE id = ? AND condominio_id = ?').get(id, ctx.cid) || fail(404, 'Encuesta no encontrada');
  // Una encuesta vencida se cierra sola al consultarla.
  const vigente = (ctx, e) => {
    if (e.estado === 'abierta' && e.cierra < hoy()) { ctx.db.prepare("UPDATE encuestas SET estado = 'cerrada' WHERE id = ?").run(e.id); e.estado = 'cerrada'; }
    return e;
  };
  const conResultados = (ctx, e, unidadesMias) => {
    vigente(ctx, e);
    const mios = unidadesMias ? ctx.db.prepare(`SELECT v.unidad_id, o.texto FROM encuesta_votos v JOIN encuesta_opciones o ON o.id = v.opcion_id WHERE v.encuesta_id = ? AND v.unidad_id IN (${unidadesMias.map(() => '?').join(',') || 'NULL'})`).all(e.id, ...unidadesMias) : [];
    const r = resultadosEncuesta(ctx.db, e);
    const ver = !unidadesMias || e.estado === 'cerrada' || mios.length > 0; // el residente ve resultados al votar o al cierre
    return { ...e, opciones: r.opciones.map(o => ver ? o : { id: o.id, texto: o.texto, orden: o.orden }), resultados: ver ? { emitidos: r.emitidos, unidades: r.unidades, participacion: r.participacion, indiviso_votado_ppm: r.indiviso_votado_ppm } : null, mis_votos: mios };
  };

  return [
    ['GET', `${C}/comunidad`, {}, ctx => {
      lectura(ctx);
      const tipo = q(ctx, 'tipo');
      if (tipo && !TIPOS.includes(tipo)) fail(400, 'Tipo inválido.');
      const res = ctx.rol === 'residente';
      const where = ['c.condominio_id = ?']; const args = [ctx.cid];
      if (tipo) { where.push('c.tipo = ?'); args.push(tipo); }
      if (res) where.push("c.publico = 1 AND c.estado <> 'archivado'");
      else if (q(ctx, 'archivados') !== '1') where.push("c.estado <> 'archivado'");
      return ctx.db.prepare(`SELECT c.*, a.nombre AS archivo_nombre, a.bytes AS archivo_bytes, u.nombre AS autor FROM comunidad c LEFT JOIN archivos a ON a.id = c.archivo_id LEFT JOIN usuarios u ON u.id = c.created_by
        WHERE ${where.join(' AND ')} ORDER BY c.fijado DESC, CASE WHEN c.tipo = 'evento' THEN c.fecha END ASC, c.created_at DESC LIMIT 500`).all(...args);
    }],
    ['POST', `${C}/comunidad`, { perm: 'comunicar' }, ctx => {
      const b = v(ctx.body, { tipo: `enum|${TIPOS.join('|')}`, ...CAMPOS });
      if (b.tipo === 'evento' && !b.fecha) fail(400, 'Indique la fecha del evento.');
      if (b.tipo === 'documento' && !b.archivo_id) fail(400, 'Adjunte el documento.');
      if (b.tipo === 'telefono' && !b.telefono) fail(400, 'Indique el teléfono.');
      if (b.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora)) fail(400, 'Hora con formato HH:MM.');
      if (b.archivo_id) ctx.db.prepare('SELECT 1 FROM archivos WHERE id = ? AND condominio_id = ?').get(b.archivo_id, ctx.cid) || fail(404, 'Archivo no encontrado');
      return escribir(ctx, `comunidad_${b.tipo}_publicado`, 'comunidad', () => Number(ctx.db.prepare(`INSERT INTO comunidad (condominio_id, tipo, titulo, cuerpo, categoria, fecha, hora, lugar, telefono, archivo_id, fijado, publico, estado, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.cid, b.tipo, b.titulo, b.cuerpo, b.categoria, b.fecha, b.hora, b.lugar, b.telefono, b.archivo_id, b.fijado ? 1 : 0, b.publico === false ? 0 : 1, b.estado || 'vigente', ctx.user.id, Date.now()).lastInsertRowid));
    }],
    ['PUT', `${C}/comunidad/:id`, { perm: 'comunicar' }, ctx => {
      const id = idParam(ctx);
      const prev = ctx.db.prepare('SELECT * FROM comunidad WHERE id = ? AND condominio_id = ?').get(id, ctx.cid) || fail(404, 'Publicación no encontrada');
      const b = v(ctx.body, CAMPOS);
      if (b.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora)) fail(400, 'Hora con formato HH:MM.');
      if (b.archivo_id) ctx.db.prepare('SELECT 1 FROM archivos WHERE id = ? AND condominio_id = ?').get(b.archivo_id, ctx.cid) || fail(404, 'Archivo no encontrado');
      return escribir(ctx, 'comunidad_actualizado', 'comunidad', () => {
        ctx.db.prepare('UPDATE comunidad SET titulo=?, cuerpo=?, categoria=?, fecha=?, hora=?, lugar=?, telefono=?, archivo_id=?, fijado=?, publico=?, estado=?, updated_at=? WHERE id=?')
          .run(b.titulo, b.cuerpo, b.categoria, b.fecha, b.hora, b.lugar, b.telefono, b.archivo_id ?? prev.archivo_id, b.fijado ? 1 : 0, b.publico === false ? 0 : 1, b.estado || prev.estado, Date.now(), id);
        return id;
      });
    }],

    // ===== Encuestas y votaciones =====
    ['GET', `${C}/encuestas`, {}, ctx => {
      lectura(ctx);
      const mias = ctx.rol === 'residente' ? unidadesDeResidente(ctx).map(u => u.id) : null;
      return ctx.db.prepare('SELECT * FROM encuestas WHERE condominio_id = ? ORDER BY estado = \'abierta\' DESC, cierra DESC, id DESC LIMIT 200').all(ctx.cid).map(e => conResultados(ctx, e, mias));
    }],
    ['POST', `${C}/encuestas`, { perm: 'comunicar' }, ctx => {
      const b = v(ctx.body, { pregunta: 'str|max200', descripcion: 'str|opt|max2000', cierra: 'date', ponderada: 'bool|opt', opciones: 'arr' });
      const ops = [...new Set(b.opciones.map(o => String(o ?? '').trim()).filter(Boolean))];
      if (ops.length < 2 || ops.length > 12) fail(400, 'La encuesta necesita de 2 a 12 opciones distintas.');
      if (ops.some(o => o.length > 120)) fail(400, 'Cada opción admite hasta 120 caracteres.');
      if (b.cierra < hoy()) fail(400, 'La fecha de cierre no puede ser pasada.');
      return escribir(ctx, 'encuesta_creada', 'encuesta', () => {
        const id = Number(ctx.db.prepare('INSERT INTO encuestas (condominio_id, pregunta, descripcion, cierra, ponderada, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(ctx.cid, b.pregunta, b.descripcion, b.cierra, b.ponderada ? 1 : 0, ctx.user.id, Date.now()).lastInsertRowid);
        const ins = ctx.db.prepare('INSERT INTO encuesta_opciones (encuesta_id, texto, orden) VALUES (?,?,?)');
        ops.forEach((o, i) => ins.run(id, o, i + 1));
        return id;
      });
    }],
    ['POST', `${C}/encuestas/:id/cerrar`, { perm: 'comunicar' }, ctx => {
      const e = encuestaDe(ctx, idParam(ctx));
      if (e.estado === 'cerrada') fail(409, 'La encuesta ya está cerrada.');
      return escribir(ctx, 'encuesta_cerrada', 'encuesta', () => { ctx.db.prepare("UPDATE encuestas SET estado = 'cerrada' WHERE id = ?").run(e.id); return e.id; });
    }],
    // El residente vota por sus unidades; la administración puede registrar el voto de una unidad (p. ej. en asamblea).
    ['POST', `${C}/encuestas/:id/votar`, {}, ctx => {
      const e = vigente(ctx, encuestaDe(ctx, idParam(ctx)));
      const b = v(ctx.body, { opcion_id: 'int|min1', unidad_id: 'int|min1' });
      if (ctx.rol === 'residente') { if (!unidadesDeResidente(ctx).some(u => u.id === b.unidad_id)) fail(404, 'Unidad no encontrada'); }
      else exigir(ctx, 'comunicar');
      if (e.estado !== 'abierta') fail(409, 'La votación ya cerró.');
      ctx.db.prepare('SELECT 1 FROM encuesta_opciones WHERE id = ? AND encuesta_id = ?').get(b.opcion_id, e.id) || fail(400, 'Opción inválida.');
      ctx.db.prepare('SELECT 1 FROM unidades WHERE id = ? AND condominio_id = ? AND activo = 1').get(b.unidad_id, ctx.cid) || fail(404, 'Unidad no encontrada');
      if (ctx.db.prepare('SELECT 1 FROM encuesta_votos WHERE encuesta_id = ? AND unidad_id = ?').get(e.id, b.unidad_id)) fail(409, 'Esta unidad ya votó; el voto no se puede cambiar.', 'DUPLICADO');
      return escribir(ctx, 'voto_registrado', 'encuesta', () => {
        ctx.db.prepare('INSERT INTO encuesta_votos (encuesta_id, unidad_id, opcion_id, usuario_id, registrado_por, created_at) VALUES (?,?,?,?,?,?)')
          .run(e.id, b.unidad_id, b.opcion_id, ctx.rol === 'residente' ? ctx.user.id : null, ctx.user.id, Date.now());
        return e.id;
      });
    }],
  ];
}
