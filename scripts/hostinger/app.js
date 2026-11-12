// Indiviso CMS · arranque para Hostinger (Node.js web app). CommonJS a propósito: el hospedaje carga este archivo con require().
// Archivo de entrada: app.js · Node.js 22 o 24 · sin dependencias (no hace falta npm install).
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const def = (k, v) => { if (!process.env[k]) process.env[k] = v; };
def('HOST', '0.0.0.0');
def('INDIVISO_TRUST_PROXY', '1');                                  // el proxy HTTPS de Hostinger indica la IP y el protocolo
def('INDIVISO_DATA', path.join(os.homedir(), 'indiviso-datos'));    // datos fuera de la app: un nuevo despliegue no los borra

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`Indiviso CMS necesita Node.js 22 o 24 (este servidor tiene ${process.versions.node}). Cámbielo en la configuración de la app.`);
  process.exit(1);
}
const entrada = path.join(__dirname, 'server', 'index.mjs');
if (maj === 22 && min < 13) {
  // SQLite integrado requiere bandera en Node 22.5–22.12
  const { spawn } = require('node:child_process');
  const hijo = spawn(process.execPath, ['--experimental-sqlite', entrada], { stdio: 'inherit', env: process.env });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => hijo.kill(s));
  hijo.on('exit', c => process.exit(c ?? 0));
} else {
  import(pathToFileURL(entrada).href).catch(e => { console.error('No se pudo iniciar Indiviso CMS:', e); process.exit(1); });
}
