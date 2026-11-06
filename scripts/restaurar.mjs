// Restaura un respaldo cifrado (.idvb).
//   node scripts/restaurar.mjs data/respaldos/indiviso-AAAAMMDD-HHMMSS.idvb            → solo descifra y verifica
//   node scripts/restaurar.mjs <archivo> --aplicar                                    → reemplaza la base (detenga antes el servidor)
import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { descifrar } from '../server/backup.mjs';
import { DB_PATH, DATA_DIR } from '../server/db.mjs';

const [archivo, flag] = process.argv.slice(2);
if (!archivo || !existsSync(archivo)) { console.error('Indique un archivo .idvb existente.'); process.exit(1); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const destino = join(DATA_DIR, `restaurado-${stamp}.db`);
writeFileSync(destino, descifrar(readFileSync(resolve(archivo))), { mode: 0o600 }); // falla si el archivo fue alterado

const t = new DatabaseSync(destino, { readOnly: true });
const integ = Object.values(t.prepare('PRAGMA integrity_check').get())[0];
const n = t.prepare('SELECT (SELECT COUNT(*) FROM polizas) p, (SELECT COUNT(*) FROM pagos) g, (SELECT COUNT(*) FROM auditoria) a').get();
t.close();
if (integ !== 'ok') { console.error('El respaldo no pasó la verificación de integridad:', integ); process.exit(1); }
console.log(`Respaldo válido → ${destino}\n  pólizas: ${n.p} · pagos: ${n.g} · bitácora: ${n.a}`);

if (flag === '--aplicar') {
  if (existsSync(DB_PATH)) {
    const previo = join(DATA_DIR, `antes-de-restaurar-${stamp}.db`);
    const live = new DatabaseSync(DB_PATH);
    live.exec(`VACUUM INTO '${previo.replace(/'/g, "''")}'`); // copia de seguridad de la base actual
    live.close();
    console.log(`Base actual resguardada en ${previo}`);
  }
  for (const s of ['-wal', '-shm']) rmSync(DB_PATH + s, { force: true });
  renameSync(destino, DB_PATH);
  console.log('Base restaurada. Inicie de nuevo el servidor.');
} else {
  console.log('Para reemplazar la base: detenga el servidor y repita con --aplicar.');
}
