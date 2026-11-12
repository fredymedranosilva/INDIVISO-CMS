<?php
// Respaldos cifrados (AES-256-GCM) con verificación de integridad y retención (equivale a server/backup.mjs).
// El formato es el mismo que el de la versión Node: un respaldo se restaura en cualquiera de las dos.
declare(strict_types=1);

const MAGIC = 'IDVB1';
const RETENER = 90;
function backup_dir(): string { $d = (string)cfg('INDIVISO_BACKUPS', data_dir() . '/respaldos'); if (!is_dir($d)) @mkdir($d, 0700, true); return $d; }
function adjuntos_dir(): string { $d = backup_dir() . '/archivos'; if (!is_dir($d)) @mkdir($d, 0700, true); return $d; }
function claveRespaldo(): string {
  $env = cfg('INDIVISO_BACKUP_KEY');
  if ($env) { $k = base64_decode((string)$env); if (strlen($k) !== 32) throw new RuntimeException('INDIVISO_BACKUP_KEY inválida'); return $k; }
  $f = data_dir() . '/respaldo.key';
  if (!is_file($f)) { file_put_contents($f, base64_encode(random_bytes(32))); @chmod($f, 0600); }
  return base64_decode(trim((string)file_get_contents($f)));
}
function cifrarR(string $plain): string { $iv = random_bytes(12); $tag = ''; $c = openssl_encrypt($plain, 'aes-256-gcm', claveRespaldo(), OPENSSL_RAW_DATA, $iv, $tag, '', 16); return MAGIC . $iv . $tag . $c; }
function descifrarR(string $b): string {
  if (substr($b, 0, 5) !== MAGIC) throw new RuntimeException('Archivo de respaldo inválido');
  $r = openssl_decrypt(substr($b, 33), 'aes-256-gcm', claveRespaldo(), OPENSSL_RAW_DATA, substr($b, 5, 12), substr($b, 17, 16));
  if ($r === false) throw new RuntimeException('El respaldo fue alterado o la llave no corresponde');
  return $r;
}
function verificarPlano(string $path): bool {
  $t = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  $ok = $t->query('PRAGMA integrity_check')->fetchColumn();
  $fk = $t->query('PRAGMA foreign_key_check')->fetchAll();
  $t = null;
  return $ok === 'ok' && !$fk;
}
function crearRespaldo(DB $db, string $motivo = 'programado'): array {
  $dir = backup_dir();
  $stamp = gmdate('Ymd-His');
  $tmp = "$dir/.tmp-$stamp-" . bin2hex(random_bytes(4)) . '.db';
  try {
    try { $db->exec("VACUUM INTO '" . str_replace("'", "''", $tmp) . "'"); }
    catch (Throwable) { $db->exec('PRAGMA wal_checkpoint(FULL)'); copy(db_path(), $tmp); }
    if (!verificarPlano($tmp)) throw new RuntimeException('La copia no pasó la verificación de integridad');
    $plain = file_get_contents($tmp); $enc = cifrarR($plain);
    $nombre = "indiviso-$stamp-" . bin2hex(random_bytes(2)) . '.idvb';
    file_put_contents("$dir/$nombre", $enc); @chmod("$dir/$nombre", 0600);
    $ok = descifrarR(file_get_contents("$dir/$nombre")) === $plain;
    $db->prepare('INSERT INTO respaldos (archivo, sha256, bytes, motivo, verificado, created_at) VALUES (?,?,?,?,?,?)')->run($nombre, sha256($enc), strlen($enc), $motivo, $ok ? 1 : 0, now_ms());
    podar();
    return ['archivo' => $nombre, 'bytes' => strlen($enc), 'verificado' => $ok, 'adjuntos' => respaldarAdjuntos()];
  } finally { @unlink($tmp); }
}
function respaldarAdjuntos(): array {
  $nuevos = 0; $total = 0; $ad = adjuntos_dir();
  foreach (is_dir(files_dir()) ? scandir(files_dir()) : [] as $f) {
    if (!preg_match('/^[0-9a-f]{64}$/', $f)) continue;
    $total++;
    $dest = "$ad/$f.idva";
    if (is_file($dest)) continue;
    file_put_contents($dest, cifrarR(file_get_contents(files_dir() . "/$f"))); @chmod($dest, 0600); $nuevos++;
  }
  return ['total' => $total, 'nuevos' => $nuevos];
}
function podar(): void {
  $fs = array_values(array_filter(scandir(backup_dir()), fn($f) => str_ends_with($f, '.idvb'))); sort($fs);
  foreach (array_slice($fs, 0, max(0, count($fs) - RETENER)) as $f) @unlink(backup_dir() . "/$f");
}
function verificarRespaldo(string $nombre): array {
  $f = backup_dir() . '/' . basename($nombre);
  if (!is_file($f)) return ['ok' => false, 'error' => 'No existe'];
  $tmp = backup_dir() . '/.verify-' . bin2hex(random_bytes(4)) . '.db';
  try { file_put_contents($tmp, descifrarR(file_get_contents($f))); return ['ok' => verificarPlano($tmp), 'bytes' => filesize($f)]; }
  catch (Throwable $e) { return ['ok' => false, 'error' => $e->getMessage()]; }
  finally { @unlink($tmp); }
}
function rutaRespaldo(string $nombre): ?string {
  $b = basename($nombre); $f = backup_dir() . "/$b";
  return preg_match('/^indiviso-[\d-]+(-[0-9a-f]{4})?\.idvb$/', $b) && is_file($f) ? $f : null;
}
// Sin procesos en segundo plano: el respaldo programado se hace en la primera petición después de 6 horas.
function respaldoSiToca(DB $db, int $horas = 6): void {
  $u = $db->prepare('SELECT MAX(created_at) t FROM respaldos')->get()['t'] ?? 0;
  if (now_ms() - (int)$u < $horas * 3600000) return;
  if (!$db->prepare('SELECT 1 FROM condominios LIMIT 1')->get()) return;
  try { crearRespaldo($db, 'programado'); } catch (Throwable $e) { error_log('[respaldo] ' . $e->getMessage()); }
}
