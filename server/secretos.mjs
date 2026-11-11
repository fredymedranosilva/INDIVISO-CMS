// Cifrado en reposo de secretos pequeños (claves TOTP): AES-256-GCM con una llave que vive fuera de la base.
// Si alguien obtiene solo la base de datos (o una copia), no obtiene los secretos de verificación en dos pasos.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DATA_DIR } from './db.mjs';

let llave = null;
function clave() {
  if (llave) return llave;
  if (process.env.INDIVISO_SECRET_KEY) {
    llave = Buffer.from(process.env.INDIVISO_SECRET_KEY, 'base64');
    if (llave.length !== 32) throw new Error('INDIVISO_SECRET_KEY debe ser de 32 bytes en base64');
    return llave;
  }
  const f = join(DATA_DIR, 'secreto.key');
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('base64'), { mode: 0o600 });
  llave = Buffer.from(readFileSync(f, 'utf8').trim(), 'base64');
  if (llave.length !== 32) throw new Error('El archivo secreto.key está dañado');
  return llave;
}

export function sellar(texto) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave(), iv);
  const body = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

// Acepta también valores anteriores sin cifrar (bases creadas antes de esta versión).
export function abrir(sellado) {
  if (sellado == null) return null;
  const s = String(sellado);
  if (!s.startsWith('v1:')) return s;
  const buf = Buffer.from(s.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', clave(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
