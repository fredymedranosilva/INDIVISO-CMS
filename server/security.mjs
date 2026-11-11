// Primitivas de seguridad: contraseñas (scrypt), tokens, TOTP (RFC 6238),
// limitación de intentos y bitácora encadenada por hash.
import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pass) {
  const salt = randomBytes(16);
  const hash = scryptSync(pass.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pass, stored) {
  try {
    const [alg, N, r, p, salt, hash] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = scryptSync(String(pass).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return timingSafeEqual(got, expected);
  } catch { return false; }
}

// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe.
export const DUMMY_HASH = hashPassword(token(12));

const COMUNES = new Set(['password', 'contraseña', '123456789012', 'qwertyuiop12', 'administrador', 'condominio123', 'passw0rd1234', 'password1234', 'password123!', 'contraseña123', 'contrasena123', 'administrador1', 'admin123456789', 'qwerty123456', '1q2w3e4r5t6y', 'abc123456789', 'indiviso1234', 'bienvenido123', 'mexico123456']);
export function passwordProblem(pass, email = '') {
  if (typeof pass !== 'string' || pass.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (pass.length > 128) return 'La contraseña es demasiado larga.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pass)).length;
  if (kinds < 3) return 'Combine al menos tres tipos: minúsculas, mayúsculas, números y símbolos.';
  if (COMUNES.has(pass.toLowerCase()) || COMUNES.has(pass.toLowerCase().replace(/[^a-z0-9ñ]/g, ''))) return 'La contraseña es demasiado común.';
  if (/^(.)\1+$/.test(pass) || /^(..?.?)\1+$/.test(pass)) return 'La contraseña no puede ser una repetición.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pass.toLowerCase().includes(local)) return 'La contraseña no debe contener su usuario.';
  return null;
}

// ---------- TOTP (compatible con Google Authenticator, Authy, 1Password) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
// Código vigente para un secreto (lo usan las pruebas automáticas y las herramientas de soporte).
export const codigoTotp = (secret, now = Date.now()) => hotp(secret, Math.floor(now / 30000));
// Devuelve el paso de tiempo usado (para impedir reutilización del mismo código) o null.
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= (lastStep || 0)) continue;
    const a = Buffer.from(hotp(secret, s)), b = Buffer.from(String(code));
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}

// Códigos de respaldo de un solo uso (por si se pierde el teléfono): se guardan solo sus hashes.
export const nuevosCodigosRespaldo = (n = 10) => Array.from({ length: n }, () => { const s = base32Encode(randomBytes(5)); return `${s.slice(0, 4)}-${s.slice(4, 8)}`; });
export const normalizarCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

// ---------- Limitación de intentos en memoria ----------
const buckets = new Map();
// Cuenta un intento y dice si sigue dentro del límite.
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.n <= max;
}
// Consulta sin contar (para límites que solo cuentan fallos) y borrado al tener éxito.
export const limiteExcedido = (key, max) => { const b = buckets.get(key); return !!b && b.reset >= Date.now() && b.n >= max; };
export const limiteLimpiar = key => { buckets.delete(key); };

// ---------- Bitácora encadenada (cualquier alteración rompe la cadena) ----------
const GENESIS = '0'.repeat(64);
export function audit(db, { usuario_id = null, condominio_id = null, ip = null, accion, entidad = null, entidad_id = null, detalle = null }) {
  const prev = db.prepare('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1').get()?.hash || GENESIS;
  const ts = Date.now();
  const det = detalle == null ? null : JSON.stringify(detalle);
  const hash = sha256([prev, ts, usuario_id, condominio_id, ip, accion, entidad, entidad_id, det].join('|'));
  db.prepare(`INSERT INTO auditoria (ts, usuario_id, condominio_id, ip, accion, entidad, entidad_id, detalle, prev_hash, hash)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ts, usuario_id, condominio_id, ip, accion, entidad, entidad_id, det, prev, hash);
}

export function verifyAuditChain(db) {
  let prev = GENESIS, n = 0;
  for (const r of db.prepare('SELECT * FROM auditoria ORDER BY id').iterate()) {
    const h = sha256([r.prev_hash, r.ts, r.usuario_id, r.condominio_id, r.ip, r.accion, r.entidad, r.entidad_id, r.detalle].join('|'));
    if (r.prev_hash !== prev || h !== r.hash) return { ok: false, registros: n, roto_en: r.id };
    prev = r.hash; n++;
  }
  return { ok: true, registros: n };
}
