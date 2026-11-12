// Punto de entrada para hospedajes Node.js (Hostinger, cPanel, etc.).
// Aplica valores seguros para producción detrás del proxy HTTPS del hospedaje y arranca server/index.mjs.
// Node 22.13 o superior trae SQLite integrado; de 22.5 a 22.12 se relanza con --experimental-sqlite.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const def = (k, v) => { if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v; };
def('HOST', '0.0.0.0');
def('INDIVISO_HTTPS', '1');          // el hospedaje termina TLS
def('INDIVISO_TRUST_PROXY', '1');    // IP real del visitante desde el proxy
def('INDIVISO_DATA', path.join(__dirname, '..', 'indiviso-datos')); // fuera de la carpeta pública

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`Indiviso CMS necesita Node.js 22.5 o superior (este servidor tiene ${process.versions.node}). Elija Node 22 en el panel del hospedaje.`);
  process.exit(1);
}
const entrada = path.join(__dirname, 'server', 'index.mjs');
if (maj === 22 && min < 13) {
  const hijo = spawn(process.execPath, ['--experimental-sqlite', entrada], { stdio: 'inherit', env: process.env });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => hijo.kill(s));
  hijo.on('exit', c => process.exit(c ?? 0));
} else {
  await import(pathToFileURL(entrada).href);
}
