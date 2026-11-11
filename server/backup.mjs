// Respaldos cifrados (AES-256-GCM) con verificación de integridad y retención.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DATA_DIR, FILES_DIR } from './db.mjs';
import { sha256 } from './security.mjs';

export const BACKUP_DIR = process.env.INDIVISO_BACKUPS || join(DATA_DIR, 'respaldos');
const MAGIC = Buffer.from('IDVB1');
const RETENER = 90;

function clave() {
  if (process.env.INDIVISO_BACKUP_KEY) {
    const k = Buffer.from(process.env.INDIVISO_BACKUP_KEY, 'base64');
    if (k.length !== 32) throw new Error('INDIVISO_BACKUP_KEY debe ser de 32 bytes en base64');
    return k;
  }
  const f = join(DATA_DIR, 'respaldo.key');
  if (!existsSync(f)) { writeFileSync(f, randomBytes(32).toString('base64'), { mode: 0o600 }); }
  return Buffer.from(readFileSync(f, 'utf8').trim(), 'base64');
}

export function cifrar(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function descifrar(buf) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('Archivo de respaldo inválido');
  const d = createDecipheriv('aes-256-gcm', clave(), buf.subarray(5, 17));
  d.setAuthTag(buf.subarray(17, 33));
  return Buffer.concat([d.update(buf.subarray(33)), d.final()]); // falla si fue alterado
}

function verificarPlano(path) {
  const t = new DatabaseSync(path, { readOnly: true });
  try {
    const ok = t.prepare('PRAGMA integrity_check').get();
    const fk = t.prepare('PRAGMA foreign_key_check').all();
    return Object.values(ok)[0] === 'ok' && fk.length === 0;
  } finally { t.close(); }
}

export function crearRespaldo(db, motivo = 'programado') {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const tmp = join(BACKUP_DIR, `.tmp-${stamp}-${randomBytes(4).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // copia consistente en caliente
  try {
    if (!verificarPlano(tmp)) throw new Error('La copia no pasó la verificación de integridad');
    const plain = readFileSync(tmp);
    const enc = cifrar(plain);
    const nombre = `indiviso-${stamp}.idvb`;
    const destino = join(BACKUP_DIR, nombre);
    writeFileSync(destino, enc, { mode: 0o600 });
    // relectura y descifrado de prueba: el respaldo solo cuenta si se puede restaurar
    const ok = descifrar(readFileSync(destino)).equals(plain);
    db.prepare('INSERT INTO respaldos (archivo, sha256, bytes, motivo, verificado, created_at) VALUES (?,?,?,?,?,?)')
      .run(nombre, sha256(enc), enc.length, motivo, ok ? 1 : 0, Date.now());
    podar();
    return { archivo: nombre, bytes: enc.length, verificado: ok, adjuntos: respaldarAdjuntos() };
  } finally { try { unlinkSync(tmp); } catch { /* ya eliminado */ } }
}

// Los adjuntos (comprobantes, facturas, documentos) no cambian una vez guardados: cada uno se copia cifrado una sola vez.
export const ADJUNTOS_DIR = join(BACKUP_DIR, 'archivos');
export function respaldarAdjuntos() {
  mkdirSync(ADJUNTOS_DIR, { recursive: true, mode: 0o700 });
  let nuevos = 0, total = 0;
  for (const f of existsSync(FILES_DIR) ? readdirSync(FILES_DIR) : []) {
    if (!/^[0-9a-f]{64}$/.test(f)) continue;
    total++;
    const destino = join(ADJUNTOS_DIR, `${f}.idva`);
    if (existsSync(destino)) continue;
    writeFileSync(destino, cifrar(readFileSync(join(FILES_DIR, f))), { mode: 0o600 });
    nuevos++;
  }
  return { total, nuevos };
}
// Restaura los adjuntos que falten en la carpeta de datos (cada uno se verifica contra su sha256).
export function restaurarAdjuntos() {
  mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  let restaurados = 0, danados = 0;
  for (const f of existsSync(ADJUNTOS_DIR) ? readdirSync(ADJUNTOS_DIR) : []) {
    const m = /^([0-9a-f]{64})\.idva$/.exec(f); if (!m) continue;
    const destino = join(FILES_DIR, m[1]);
    if (existsSync(destino)) continue;
    try {
      const plano = descifrar(readFileSync(join(ADJUNTOS_DIR, f)));
      if (sha256(plano) !== m[1]) throw new Error('contenido alterado');
      writeFileSync(destino, plano, { mode: 0o600 }); restaurados++;
    } catch { danados++; }
  }
  return { restaurados, danados };
}

function podar() {
  const files = readdirSync(BACKUP_DIR).filter(f => f.endsWith('.idvb')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - RETENER))) unlinkSync(join(BACKUP_DIR, f));
}

export function verificarRespaldo(nombre) {
  const f = join(BACKUP_DIR, basename(nombre));
  if (!existsSync(f)) return { ok: false, error: 'No existe' };
  const tmp = join(BACKUP_DIR, `.verify-${randomBytes(4).toString('hex')}.db`);
  try {
    writeFileSync(tmp, descifrar(readFileSync(f)), { mode: 0o600 });
    return { ok: verificarPlano(tmp), bytes: statSync(f).size };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { try { unlinkSync(tmp); } catch { /* nada */ } }
}

export function rutaRespaldo(nombre) {
  const f = join(BACKUP_DIR, basename(nombre));
  if (!/^indiviso-[\d-]+\.idvb$/.test(basename(nombre)) || !existsSync(f)) return null;
  return f;
}

export function programarRespaldos(db, horas = 6) {
  const ultimo = db.prepare('SELECT MAX(created_at) t FROM respaldos').get().t || 0;
  const correr = () => { try { crearRespaldo(db, 'programado'); } catch (e) { console.error('[respaldo] error:', e.message); } };
  if (Date.now() - ultimo > horas * 3600000) setTimeout(correr, 5000);
  setInterval(correr, horas * 3600000).unref();
}
