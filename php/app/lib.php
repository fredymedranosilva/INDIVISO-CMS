<?php
// Indiviso CMS · versión PHP. Utilidades compartidas, seguridad, cifrado de secretos y base de datos.
// Equivale a server/util.mjs, security.mjs, secretos.mjs y db.mjs de la versión Node.
declare(strict_types=1);

// ---------- Configuración ----------
// config.php (opcional, junto a api.php) puede definir: INDIVISO_DATA, INDIVISO_TZ, INDIVISO_HOSTS.
$GLOBALS['CFG'] = is_file(__DIR__ . '/../config.php') ? (require __DIR__ . '/../config.php') : [];
function cfg(string $k, $def = null) { $v = getenv($k); if ($v !== false && $v !== '') return $v; return $GLOBALS['CFG'][$k] ?? $def; }
date_default_timezone_set((string)cfg('INDIVISO_TZ', 'America/Mexico_City'));

function data_dir(): string {
  static $d = null; if ($d) return $d;
  $d = (string)cfg('INDIVISO_DATA', '');
  if ($d === '') {
    // Fuera de la carpeta pública si se puede (…/public_html/../indiviso-datos); si no, dentro, protegida por .htaccess.
    $fuera = dirname(__DIR__, 2) . '/indiviso-datos';
    $d = (is_dir($fuera) || @mkdir($fuera, 0700, true)) && is_writable($fuera) ? $fuera : dirname(__DIR__) . '/datos';
  }
  if (!is_dir($d)) @mkdir($d, 0700, true);
  if (str_starts_with(realpath($d) ?: $d, realpath(dirname(__DIR__)) ?: dirname(__DIR__))) {
    if (!is_file("$d/.htaccess")) @file_put_contents("$d/.htaccess", "Require all denied\nDeny from all\n");
  }
  if (!is_dir("$d/archivos")) @mkdir("$d/archivos", 0700, true);
  return $d;
}
function files_dir(): string { return data_dir() . '/archivos'; }

// ---------- Errores de negocio ----------
final class AppError extends Exception {
  public int $status; public ?string $codigo;
  public function __construct(int $status, string $msg, ?string $code = null) { parent::__construct($msg); $this->status = $status; $this->codigo = $code; }
}
function fail(int $status, string $msg, ?string $code = null): never { throw new AppError($status, $msg, $code); }

function dbError(Throwable $e): ?AppError {
  $m = $e->getMessage();
  if (($i = strpos($m, 'INMUTABLE')) !== false) { $t = substr($m, $i + 11); return new AppError(409, $t !== '' ? $t : 'Registro inmutable.', 'INMUTABLE'); }
  if (str_contains($m, 'PERIODO_CERRADO')) return new AppError(409, 'El periodo contable está cerrado; el movimiento no puede registrarse en esa fecha.', 'PERIODO_CERRADO');
  if (str_contains($m, 'UNIQUE constraint failed')) return new AppError(409, 'El registro ya existe (se evitó un duplicado).', 'DUPLICADO');
  if (str_contains($m, 'CHECK constraint failed')) return new AppError(400, 'Los datos no cumplen las reglas de validación.', 'VALIDACION');
  if (str_contains($m, 'FOREIGN KEY constraint failed')) return new AppError(400, 'Referencia a un registro inexistente.', 'REFERENCIA');
  return null;
}

// ---------- Números y fechas ----------
function now_ms(): int { return (int)floor(microtime(true) * 1000); }
function jround(float|int $x): int { return (int)floor($x + 0.5); } // Math.round de JS
function hoy(): string { return date('Y-m-d'); }
function periodoDe(string $f): string { return substr($f, 0, 7); }
function periodoActual(): string { return periodoDe(hoy()); }
function fechaOperable(string $fecha, string $campo = 'La fecha'): string {
  if ($fecha > hoy()) fail(400, "$campo no puede ser futura.");
  if ($fecha < '2000-01-01') fail(400, "$campo es demasiado antigua.");
  return $fecha;
}
function pad2(int $n): string { return str_pad((string)$n, 2, '0', STR_PAD_LEFT); }
function addMonths(string $p, int $n): string {
  [$y, $m] = array_map('intval', explode('-', $p));
  $t = $y * 12 + ($m - 1) + $n;
  return intdiv($t, 12) . '-' . pad2($t % 12 + 1);
}
function addDays(string $f, int $n): string { $d = new DateTimeImmutable($f . 'T12:00:00Z'); return $d->modify(($n >= 0 ? '+' : '') . $n . ' day')->format('Y-m-d'); }
function diffDays(string $a, string $b): int { return jround(((new DateTimeImmutable($a . 'T12:00:00Z'))->getTimestamp() - (new DateTimeImmutable($b . 'T12:00:00Z'))->getTimestamp()) / 86400); }
function finDeMes(string $p): string { [$y, $m] = array_map('intval', explode('-', $p)); return $p . '-' . pad2(cal_days($y, $m)); }
function cal_days(int $y, int $m): int { return (int)(new DateTimeImmutable(sprintf('%04d-%02d-01', $y, $m)))->format('t'); }
const MESES_N = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function nombrePeriodo(string $p): string { return MESES_N[(int)substr($p, 5, 2) - 1] . ' ' . substr($p, 0, 4); }
function isDate($s): bool {
  if (!is_string($s) || !preg_match('/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/', $s, $m)) return false;
  return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}
function isPeriodo($s): bool { return is_string($s) && (bool)preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $s); }
function mlen(string $s): int { return mb_strlen($s, 'UTF-8'); }
function mslice(string $s, int $a, ?int $len = null): string { return mb_substr($s, $a, $len, 'UTF-8'); }
function esInt($x): bool { return is_int($x) && abs($x) <= 9007199254740991; }

// v(body, ['campo' => 'tipo|opt']) → arreglo limpio o error 400.
function v($body, array $spec): array {
  $out = [];
  $src = is_array($body) ? $body : [];
  foreach ($spec as $k => $rule) {
    $parts = explode('|', $rule); $type = array_shift($parts); $mods = $parts;
    $opt = in_array('opt', $mods, true);
    $val = $src[$k] ?? null;
    if ($val === null || $val === '') { if ($opt) { $out[$k] = null; continue; } fail(400, "Falta el campo «{$k}»."); }
    $modNum = function (string $pre) use ($mods) { foreach ($mods as $m) if (str_starts_with($m, $pre) && is_numeric(substr($m, strlen($pre)))) return (float)substr($m, strlen($pre)); return null; };
    switch ($type) {
      case 'str':
        if (!is_string($val)) fail(400, "«{$k}» debe ser texto.");
        $val = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', trim($val)) ?? '';
        $max = (int)($modNum('max') ?? 200);
        if (mlen($val) > $max) fail(400, "«{$k}» excede {$max} caracteres.");
        if ($val === '' && !$opt) fail(400, "Falta el campo «{$k}».");
        break;
      case 'int':
        if (is_string($val) && preg_match('/^-?\d+$/', $val)) $val = (int)$val;
        if (is_float($val) && floor($val) == $val && abs($val) <= 9007199254740991) $val = (int)$val;
        if (!esInt($val)) fail(400, "«{$k}» debe ser un entero.");
        if (($mn = $modNum('min')) !== null && $val < $mn) fail(400, "«{$k}» es menor al mínimo permitido.");
        if (($mx = $modNum('max')) !== null && $val > $mx) fail(400, "«{$k}» excede el máximo permitido.");
        break;
      case 'cents':
        if (is_string($val) && preg_match('/^\d+$/', $val)) $val = (int)$val;
        if (is_float($val) && floor($val) == $val && abs($val) <= 9007199254740991) $val = (int)$val;
        if (!esInt($val) || $val < 0) fail(400, "«{$k}» debe ser un importe válido.");
        if ($val > 10000000000) fail(400, "«{$k}» excede el importe máximo.");
        if (!in_array('zero', $mods, true) && $val === 0) fail(400, "«{$k}» debe ser mayor a cero.");
        break;
      case 'date': if (!isDate($val)) fail(400, "«{$k}» debe ser una fecha AAAA-MM-DD."); break;
      case 'periodo': if (!isPeriodo($val)) fail(400, "«{$k}» debe ser un periodo AAAA-MM."); break;
      case 'bool': $val = $val === true || $val === 1 || $val === '1' || $val === 'true'; break;
      case 'email':
        if (!is_string($val) || !preg_match('/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i', trim($val))) fail(400, "«{$k}» no es un correo válido.");
        $val = mb_strtolower(trim($val)); break;
      case 'rfc':
        if (!is_string($val) || !preg_match('/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/iu', trim($val))) fail(400, "«{$k}» no es un RFC válido.");
        $val = mb_strtoupper(trim($val)); break;
      case 'uuid':
        if (!is_string($val) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', trim($val))) fail(400, "«{$k}» no es un UUID de CFDI válido.");
        $val = strtoupper(trim($val)); break;
      case 'enum':
        $opts = array_values(array_filter($mods, fn($m) => $m !== 'opt'));
        if (!is_string($val) || !in_array($val, $opts, true)) fail(400, "«{$k}» tiene un valor no permitido.");
        break;
      case 'arr': if (!is_array($val) || !array_is_list($val)) fail(400, "«{$k}» debe ser una lista."); if (count($val) > 5000) fail(400, "«{$k}» es demasiado larga."); break;
      case 'key': if (!is_string($val) || !preg_match('/^[A-Za-z0-9_-]{8,80}$/', $val)) fail(400, "«{$k}» inválido."); break;
      default: fail(500, 'Regla de validación desconocida');
    }
    $out[$k] = $val;
  }
  return $out;
}

// Reparte un total en partes proporcionales sin perder centavos (residuo mayor).
function prorratear(int $total, array $pesos): array {
  $sum = array_sum($pesos);
  if ($sum <= 0) fail(400, 'No hay base de prorrateo (indivisos en cero).');
  $raw = array_map(fn($w) => $total * $w / $sum, $pesos);
  $base = array_map(fn($r) => (int)floor($r), $raw);
  $rest = $total - array_sum($base);
  $fr = []; foreach ($raw as $i => $r) $fr[] = [$r - $base[$i], $i];
  usort($fr, fn($a, $b) => $b[0] <=> $a[0] ?: $a[1] <=> $b[1]);
  foreach ($fr as [, $i]) { if ($rest > 0) { $base[$i]++; $rest--; } }
  return $base;
}
function mask($s): ?string { if ($s === null || $s === '') return null; $t = preg_replace('/\s/', '', (string)$s); return '•••• ' . substr($t, -4); }

// ---------- Seguridad ----------
function sha256(string $d): string { return hash('sha256', $d); }
function b64url(string $b): string { return rtrim(strtr(base64_encode($b), '+/', '-_'), '='); }
function token(int $bytes = 32): string { return b64url(random_bytes($bytes)); }
function nfkc(string $s): string { return class_exists('Normalizer') ? (Normalizer::normalize($s, Normalizer::FORM_KC) ?: $s) : $s; }
function hashPassword(string $p): string {
  $p = nfkc($p);
  if (defined('PASSWORD_ARGON2ID')) return password_hash($p, PASSWORD_ARGON2ID);
  return 'b2$' . password_hash(base64_encode(hash('sha384', $p, true)), PASSWORD_BCRYPT, ['cost' => 12]);
}
function verifyPassword($p, ?string $stored): bool {
  if (!is_string($p) || !$stored) return false;
  $p = nfkc($p);
  if (str_starts_with($stored, 'b2$')) return password_verify(base64_encode(hash('sha384', $p, true)), substr($stored, 3));
  return password_verify($p, $stored);
}
function dummyHash(): string { static $h = null; return $h ??= hashPassword(token(12)); }

const COMUNES = ['password', 'contraseña', '123456789012', 'qwertyuiop12', 'administrador', 'condominio123', 'passw0rd1234', 'password1234', 'password123!', 'contraseña123', 'contrasena123', 'administrador1', 'admin123456789', 'qwerty123456', '1q2w3e4r5t6y', 'abc123456789', 'indiviso1234', 'bienvenido123', 'mexico123456'];
function passwordProblem($pass, string $email = ''): ?string {
  if (!is_string($pass) || mlen($pass) < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (mlen($pass) > 128) return 'La contraseña es demasiado larga.';
  $kinds = 0; foreach (['/[a-z]/', '/[A-Z]/', '/\d/', '/[^A-Za-z0-9]/'] as $r) if (preg_match($r, $pass)) $kinds++;
  if ($kinds < 3) return 'Combine al menos tres tipos: minúsculas, mayúsculas, números y símbolos.';
  $l = mb_strtolower($pass);
  if (in_array($l, COMUNES, true) || in_array(preg_replace('/[^a-z0-9ñ]/u', '', $l), COMUNES, true)) return 'La contraseña es demasiado común.';
  if (preg_match('/^(.)\1+$/u', $pass) || preg_match('/^(..?.?)\1+$/u', $pass)) return 'La contraseña no puede ser una repetición.';
  $local = mb_strtolower(explode('@', $email)[0]);
  if (mlen($local) >= 4 && str_contains($l, $local)) return 'La contraseña no debe contener su usuario.';
  return null;
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(string $buf): string {
  $bits = 0; $value = 0; $out = '';
  foreach (str_split($buf) as $c) { $value = (($value << 8) | ord($c)) & 0xFFFFFF; $bits += 8; while ($bits >= 5) { $out .= B32[($value >> ($bits - 5)) & 31]; $bits -= 5; } }
  if ($bits > 0) $out .= B32[($value << (5 - $bits)) & 31];
  return $out;
}
function base32Decode(string $s): string {
  $bits = 0; $value = 0; $out = '';
  foreach (str_split(strtoupper(rtrim($s, '='))) as $c) { $i = strpos(B32, $c); if ($i === false) continue; $value = (($value << 5) | $i) & 0xFFFFFF; $bits += 5; if ($bits >= 8) { $out .= chr(($value >> ($bits - 8)) & 255); $bits -= 8; } }
  return $out;
}
function hotp(string $secret, int $counter): string {
  $h = hash_hmac('sha1', pack('J', $counter), base32Decode($secret), true);
  $o = ord($h[19]) & 15;
  $code = (((ord($h[$o]) & 127) << 24) | (ord($h[$o + 1]) << 16) | (ord($h[$o + 2]) << 8) | ord($h[$o + 3])) % 1000000;
  return str_pad((string)$code, 6, '0', STR_PAD_LEFT);
}
function newTotpSecret(): string { return base32Encode(random_bytes(20)); }
function verifyTotp(string $secret, $code, ?int $lastStep = 0): ?int {
  $code = (string)($code ?? '');
  if (!preg_match('/^\d{6}$/', $code)) return null;
  $step = intdiv(now_ms(), 30000);
  foreach ([0, -1, 1] as $d) { $s = $step + $d; if ($s <= (int)$lastStep) continue; if (hash_equals(hotp($secret, $s), $code)) return $s; }
  return null;
}
function nuevosCodigosRespaldo(int $n = 10): array { $o = []; for ($i = 0; $i < $n; $i++) { $s = base32Encode(random_bytes(5)); $o[] = substr($s, 0, 4) . '-' . substr($s, 4, 4); } return $o; }
function normalizarCodigo($c): string { return preg_replace('/[^A-Z2-7]/', '', strtoupper((string)($c ?? ''))); }

// ---------- Límites de intentos (persistentes: PHP no conserva memoria entre peticiones) ----------
function rateLimit(string $key, int $max, int $windowMs): bool {
  $db = db(); $now = now_ms();
  $r = $db->prepare('SELECT n, reset FROM limites WHERE k = ?')->get($key);
  if (!$r || $r['reset'] < $now) { $db->prepare('INSERT OR REPLACE INTO limites (k, n, reset) VALUES (?,1,?)')->run($key, $now + $windowMs); $n = 1; }
  else { $db->prepare('UPDATE limites SET n = n + 1 WHERE k = ?')->run($key); $n = $r['n'] + 1; }
  if (random_int(1, 200) === 1) $db->prepare('DELETE FROM limites WHERE reset < ?')->run($now);
  return $n <= $max;
}
function limiteExcedido(string $key, int $max): bool { $r = db()->prepare('SELECT n, reset FROM limites WHERE k = ?')->get($key); return $r && $r['reset'] >= now_ms() && $r['n'] >= $max; }
function limiteLimpiar(string $key): void { db()->prepare('DELETE FROM limites WHERE k = ?')->run($key); }

// ---------- Bitácora encadenada ----------
const GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
function jenc($x): string { return json_encode($x, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION); }
function audit(DB $db, array $a): void {
  $prev = $db->prepare('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1')->get()['hash'] ?? GENESIS;
  $ts = now_ms();
  $det = array_key_exists('detalle', $a) && $a['detalle'] !== null ? jenc($a['detalle']) : null;
  $f = [$a['usuario_id'] ?? null, $a['condominio_id'] ?? null, $a['ip'] ?? null, $a['accion'], $a['entidad'] ?? null, $a['entidad_id'] ?? null];
  $hash = sha256(implode('|', array_map(fn($x) => $x === null ? '' : (string)$x, [$prev, $ts, ...$f, $det])));
  $db->prepare('INSERT INTO auditoria (ts, usuario_id, condominio_id, ip, accion, entidad, entidad_id, detalle, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)')->run($ts, ...[...$f, $det, $prev, $hash]);
}
function verifyAuditChain(DB $db): array {
  $prev = GENESIS; $n = 0;
  foreach ($db->prepare('SELECT * FROM auditoria ORDER BY id')->iterate() as $r) {
    $h = sha256(implode('|', array_map(fn($x) => $x === null ? '' : (string)$x, [$r['prev_hash'], $r['ts'], $r['usuario_id'], $r['condominio_id'], $r['ip'], $r['accion'], $r['entidad'], $r['entidad_id'], $r['detalle']])));
    if ($r['prev_hash'] !== $prev || $h !== $r['hash']) return ['ok' => false, 'registros' => $n, 'roto_en' => $r['id']];
    $prev = $r['hash']; $n++;
  }
  return ['ok' => true, 'registros' => $n];
}

// ---------- Cifrado de secretos (AES-256-GCM, llave fuera de la base) ----------
function llave(): string {
  static $k = null; if ($k) return $k;
  $env = cfg('INDIVISO_SECRET_KEY');
  if ($env) { $k = base64_decode((string)$env); if (strlen($k) !== 32) throw new RuntimeException('INDIVISO_SECRET_KEY inválida'); return $k; }
  $f = data_dir() . '/secreto.key';
  if (!is_file($f)) { file_put_contents($f, base64_encode(random_bytes(32))); @chmod($f, 0600); }
  $k = base64_decode(trim((string)file_get_contents($f)));
  if (strlen($k) !== 32) throw new RuntimeException('El archivo secreto.key está dañado');
  return $k;
}
function sellar(string $t): string { $iv = random_bytes(12); $tag = ''; $c = openssl_encrypt($t, 'aes-256-gcm', llave(), OPENSSL_RAW_DATA, $iv, $tag, '', 16); return 'v1:' . base64_encode($iv . $tag . $c); }
function abrir($s): ?string {
  if ($s === null) return null; $s = (string)$s;
  if (!str_starts_with($s, 'v1:')) return $s;
  $b = base64_decode(substr($s, 3));
  $r = openssl_decrypt(substr($b, 28), 'aes-256-gcm', llave(), OPENSSL_RAW_DATA, substr($b, 0, 12), substr($b, 12, 16));
  if ($r === false) throw new RuntimeException('No se pudo descifrar');
  return $r;
}

// ---------- Base de datos (SQLite vía PDO) ----------
final class Stmt {
  public function __construct(private PDOStatement $st) {}
  private function exe(array $a): void { $i = 1; foreach ($a as $x) { $this->st->bindValue($i++, is_bool($x) ? (int)$x : $x, $x === null ? PDO::PARAM_NULL : (is_int($x) || is_bool($x) ? PDO::PARAM_INT : PDO::PARAM_STR)); } $this->st->execute(); }
  public function get(...$a): ?array { $this->exe($a); $r = $this->st->fetch(PDO::FETCH_ASSOC); $this->st->closeCursor(); return $r === false ? null : $r; }
  public function all(...$a): array { $this->exe($a); $r = $this->st->fetchAll(PDO::FETCH_ASSOC); $this->st->closeCursor(); return $r; }
  public function run(...$a): array { $this->exe($a); $n = $this->st->rowCount(); $this->st->closeCursor(); return ['changes' => $n, 'lastInsertRowid' => (int)$GLOBALS['__pdo']->lastInsertId()]; }
  public function iterate(...$a): Generator { $this->exe($a); while (($r = $this->st->fetch(PDO::FETCH_ASSOC)) !== false) yield $r; $this->st->closeCursor(); }
}
final class DB {
  public PDO $pdo; private array $cache = [];
  public function __construct(string $path) {
    $this->pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_STRINGIFY_FETCHES => false, PDO::ATTR_TIMEOUT => 10]);
    $GLOBALS['__pdo'] = $this->pdo;
  }
  public function prepare(string $sql): Stmt { return new Stmt($this->cache[$sql] ??= $this->pdo->prepare($sql)); }
  public function exec(string $sql): void { $this->pdo->exec($sql); }
}
function db_path(): string { return data_dir() . '/indiviso.db'; }
function db(): DB {
  static $db = null; if ($db) return $db;
  $path = db_path(); $fresh = !is_file($path);
  $db = new DB($path);
  $db->exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 8000; PRAGMA trusted_schema = OFF;');
  $ver = $db->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'limites'")->get();
  if ($fresh || !$ver || !is_file(data_dir() . '/.esquema-' . VERSION_ESQUEMA)) {
    $db->pdo->exec(file_get_contents(__DIR__ . '/esquema.sql'));
    $db->exec('CREATE TABLE IF NOT EXISTS limites (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)');
    migrar($db);
    @file_put_contents(data_dir() . '/.esquema-' . VERSION_ESQUEMA, '1');
  }
  if ($fresh) @chmod($path, 0600);
  return $db;
}
const VERSION_ESQUEMA = '2.0.0';
const GASTO_FIJO = ['5201', '5202', '5203', '5301', '5401', '5402', '5403', '5501'];
function tipoGastoPorDefecto(DB $db): void {
  $ph = implode(',', array_fill(0, count(GASTO_FIJO), '?'));
  $db->prepare("UPDATE cuentas SET tipo_gasto = CASE WHEN codigo IN ($ph) THEN 'fijo' ELSE 'variable' END WHERE tipo = 'egreso' AND tipo_gasto IS NULL")->run(...GASTO_FIJO);
}
function migrar(DB $db): void {
  $cols = [
    ['cuentas', 'tipo_gasto', "TEXT CHECK (tipo_gasto IN ('fijo','variable'))"],
    ['condominios', 'pronto_pago_bp', 'INTEGER NOT NULL DEFAULT 0 CHECK (pronto_pago_bp BETWEEN 0 AND 5000)'],
    ['condominios', 'pronto_pago_dia', 'INTEGER NOT NULL DEFAULT 0 CHECK (pronto_pago_dia BETWEEN 0 AND 28)'],
    ['cargos', 'fondo_cuenta_id', 'INTEGER REFERENCES cuentas(id)'],
    ['egresos', 'fondo_id', 'INTEGER REFERENCES fondos(id)'],
    ['condominios', 'recargo_modo', "TEXT NOT NULL DEFAULT 'saldo' CHECK (recargo_modo IN ('saldo','cuota','fijo'))"],
    ['condominios', 'recargo_fijo_cents', 'INTEGER NOT NULL DEFAULT 0 CHECK (recargo_fijo_cents >= 0)'],
    ['usuarios', 'debe_cambiar_pass', 'INTEGER NOT NULL DEFAULT 0'],
    ['usuarios', 'pass_temporal_hasta', 'INTEGER'],
    ['condominios', 'logo_archivo_id', 'INTEGER REFERENCES archivos(id)'],
  ];
  foreach ($cols as [$t, $c, $def]) if (!$db->prepare("SELECT 1 FROM pragma_table_info('$t') WHERE name = ?")->get($c)) $db->exec("ALTER TABLE $t ADD COLUMN $c $def");
  tipoGastoPorDefecto($db);
  $db->exec('DROP TRIGGER IF EXISTS t_pol_periodo');
}
// Transacción con bloqueo de escritura inmediato (anidable: las internas usan el mismo bloque).
function tx(DB $db, callable $fn) {
  static $nivel = 0;
  if ($nivel > 0) { $nivel++; try { return $fn(); } finally { $nivel--; } }
  $db->exec('BEGIN IMMEDIATE'); $nivel = 1;
  try { $r = $fn(); $db->exec('COMMIT'); return $r; }
  catch (Throwable $e) { try { $db->exec('ROLLBACK'); } catch (Throwable) {} throw $e; }
  finally { $nivel = 0; }
}

// Ayudas de colecciones al estilo JS
function col(array $rows, string $k): array { return array_map(fn($r) => $r[$k], $rows); }
function suma(array $rows, $k): int|float { $s = 0; foreach ($rows as $r) $s += $k instanceof Closure ? $k($r) : ($r[$k] ?? 0); return $s; }
function find(array $a, callable $f) { foreach ($a as $x) if ($f($x)) return $x; return null; }
function some(array $a, callable $f): bool { foreach ($a as $x) if ($f($x)) return true; return false; }
function every(array $a, callable $f): bool { foreach ($a as $x) if (!$f($x)) return false; return true; }
function filt(array $a, callable $f): array { return array_values(array_filter($a, $f)); }
function obj(array $a): array|stdClass { return $a ? $a : new stdClass(); }
