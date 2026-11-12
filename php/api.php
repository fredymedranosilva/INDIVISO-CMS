<?php
// Indiviso CMS · punto de entrada de la API en PHP (hospedaje compartido, sin Node.js).
// .htaccess envía aquí toda petición a /api/…; la interfaz (index.html, js, css) la sirve el propio Apache/LiteSpeed.
// Cada petición: cabeceras de seguridad, origen, sesión + 2FA + CSRF, permiso de la ruta y aislamiento por condominio.
declare(strict_types=1);

if (PHP_VERSION_ID < 80100) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); echo json_encode(['error' => 'Indiviso CMS necesita PHP 8.1 o superior. Cámbielo en el panel del hospedaje.']); exit; }
foreach (['pdo_sqlite', 'openssl', 'mbstring'] as $ext) if (!extension_loaded($ext)) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); echo json_encode(['error' => "Falta la extensión PHP «{$ext}». Actívela en el panel del hospedaje."]); exit; }

ini_set('display_errors', '0');
ini_set('memory_limit', '256M');
set_time_limit(120);
// Avisos de PHP como excepciones: un dato inesperado nunca se procesa a medias.
set_error_handler(function (int $no, string $msg, string $file, int $line) { if (!(error_reporting() & $no)) return false; throw new ErrorException($msg, 0, $no, $file, $line); });

require __DIR__ . '/app/lib.php';
require __DIR__ . '/app/auth.php';
require __DIR__ . '/app/finanzas.php';
require __DIR__ . '/app/reportes.php';
require __DIR__ . '/app/importar.php';
require __DIR__ . '/app/backup.php';
require __DIR__ . '/app/api.php';

function cabeceras(bool $secure): void {
  header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" . ($secure ? '; upgrade-insecure-requests' : ''));
  header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  header('Cross-Origin-Opener-Policy: same-origin');
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: DENY');
  header('Referrer-Policy: no-referrer');
  header('Cross-Origin-Resource-Policy: same-origin');
  header('Cache-Control: no-store');
  if ($secure) header('Strict-Transport-Security: max-age=63072000; includeSubDomains');
}
function enviar(int $status, $obj): never {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE);
  exit;
}
function ipCliente(): string {
  // En hospedaje compartido el proxy de la plataforma agrega la IP real; si no hay proxy, se usa la conexión directa.
  $xs = array_values(array_filter(array_map('trim', explode(',', (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '')))));
  if ($xs && cfg('INDIVISO_TRUST_PROXY', '1') === '1') return substr($xs[count($xs) - 1], 0, 64);
  return (string)($_SERVER['REMOTE_ADDR'] ?? '');
}
function esHttps(): bool {
  if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
  if ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443) return true;
  return strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https' || strtolower((string)($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on';
}
function leerCuerpo(int $limite): array {
  $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
  if ($len > $limite) fail(413, 'La solicitud es demasiado grande.');
  $raw = file_get_contents('php://input', false, null, 0, $limite + 1);
  if ($raw === false || $raw === '') return [];
  if (strlen($raw) > $limite) fail(413, 'La solicitud es demasiado grande.');
  if (!str_starts_with(strtolower((string)($_SERVER['CONTENT_TYPE'] ?? '')), 'application/json')) fail(415, 'Se esperaba JSON.');
  $j = json_decode($raw, true, 64);
  if (json_last_error() !== JSON_ERROR_NONE) fail(400, 'JSON inválido.');
  if (!is_array($j) || (array_is_list($j) && $j)) fail(400, 'Se esperaba un objeto JSON.');
  return $j;
}

// Instalación: mientras no exista ningún usuario, la pantalla de acceso ofrece crear al superadministrador.
function rutasInstalacion(): array { return [
  ['GET', '/api/instalacion', ['publico' => true], fn(Ctx $ctx) => ['pendiente' => !$ctx->db->prepare('SELECT 1 FROM usuarios LIMIT 1')->get(), 'version' => VERSION, 'motor' => 'php']],
  ['POST', '/api/instalacion', ['publico' => true], function (Ctx $ctx) {
    if (!rateLimit('instalar:' . $ctx->ip, 10, 3600000)) fail(429, 'Demasiados intentos.');
    $b = v($ctx->body, ['nombre' => 'str|max120', 'email' => 'email', 'password' => 'str|max128']);
    if ($p = passwordProblem($b['password'], $b['email'])) fail(400, $p);
    return tx($ctx->db, function () use ($ctx, $b) {
      if ($ctx->db->prepare('SELECT 1 FROM usuarios LIMIT 1')->get()) fail(409, 'El sistema ya fue instalado. Inicie sesión.');
      $now = now_ms();
      $id = $ctx->db->prepare('INSERT INTO usuarios (email, nombre, pass_hash, superadmin, created_at, pass_cambiado_at) VALUES (?,?,?,1,?,?)')->run($b['email'], $b['nombre'], hashPassword($b['password']), $now, $now)['lastInsertRowid'];
      audit($ctx->db, ['usuario_id' => $id, 'ip' => $ctx->ip, 'accion' => 'instalacion', 'detalle' => ['motor' => 'php']]);
      return ['ok' => true];
    });
  }],
]; }

header_remove('X-Powered-By');
$ctx = new Ctx();
$ctx->secure = esHttps();
$ctx->ip = ipCliente();
cabeceras($ctx->secure);
$metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$ruta = rawurldecode((string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));
// Si la aplicación vive en una subcarpeta (dominio.com/cms/), se recorta el prefijo.
if (($i = strpos($ruta, '/api/')) !== false) $ruta = substr($ruta, $i); elseif (str_ends_with($ruta, '/api')) $ruta = '/api';
$ctx->query = $_GET;

try {
  if (str_contains($ruta, "\0") || !mb_check_encoding($ruta, 'UTF-8') || preg_match('/%(?![0-9a-fA-F]{2})/', (string)($_SERVER['REQUEST_URI'] ?? ''))) fail(400, 'Dirección inválida.');
  $sitio = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
  if ($sitio === 'cross-site' || ($sitio === 'same-site' && $metodo !== 'GET')) enviar(403, ['error' => 'Origen no permitido.', 'code' => 'ORIGEN']);
  $ctx->db = db();
  $rate = (int)cfg('INDIVISO_RATE', '0');
  if ($rate > 0 && !rateLimit('api:' . $ctx->ip, $rate, 60000)) { header('Retry-After: 30'); enviar(429, ['error' => 'Demasiadas solicitudes. Espere un momento.']); }
  $hallada = null;
  foreach ([...rutasInstalacion(), ...authRoutes(), ...apiRoutes()] as [$m, $patron, $opts, $handler]) {
    if ($m !== $metodo) continue;
    $keys = [];
    $re = '#^' . preg_replace_callback('/:(\w+)/', function ($x) use (&$keys) { $keys[] = $x[1]; return '([^/]+)'; }, $patron) . '$#';
    if (preg_match($re, $ruta, $mm)) { foreach ($keys as $i => $k) $ctx->params[$k] = $mm[$i + 1]; $hallada = [$opts, $handler]; break; }
  }
  if (!$hallada) enviar(404, ['error' => 'Recurso no encontrado']);
  [$opts, $handler] = $hallada;
  if ($metodo !== 'GET') { checkOrigin($ctx); $ctx->body = leerCuerpo($opts['limite'] ?? 1000000); }
  if (empty($opts['publico'])) {
    loadSession($ctx);
    if (!$ctx->user) fail(401, 'Sesión no válida o expirada.', 'SESION');
    if (!$ctx->sess['mfa_ok'] && empty($opts['mfaPendiente'])) fail(401, 'Falta la verificación en dos pasos.', 'MFA');
    if ($metodo !== 'GET') checkCsrf($ctx);
    if ($ctx->user['debe_cambiar_pass'] && empty($opts['cambioPendiente'])) fail(403, 'Cambie su contraseña temporal para continuar.', 'CAMBIO_PASSWORD');
    if (isset($ctx->params['cid'])) resolverCondominio($ctx, $opts['perm'] ?? null);
  }
  $out = $handler($ctx);
  if (random_int(1, 50) === 1) { try { limpiarSesiones($ctx->db); respaldoSiToca($ctx->db); } catch (Throwable $e) { error_log('[mantenimiento] ' . $e->getMessage()); } }
  if (is_array($out) && isset($out['__file'])) {
    $f = $out['__file'];
    if (!is_file($f['path'])) fail(404, 'Archivo no encontrado');
    header('Content-Type: ' . $f['mime']);
    header('Content-Length: ' . filesize($f['path']));
    header('Content-Disposition: ' . (!empty($f['inline']) ? 'inline' : 'attachment') . '; filename="' . rawurlencode($f['name']) . '"');
    header("Content-Security-Policy: default-src 'none'; sandbox");
    readfile($f['path']);
    exit;
  }
  if (is_array($out) && isset($out['__raw'])) {
    header('Content-Type: ' . $out['__raw']['mime']);
    header('Content-Disposition: attachment; filename="' . rawurlencode($out['__raw']['name']) . '"');
    echo $out['__raw']['body'];
    exit;
  }
  enviar(200, $out ?? ['ok' => true]);
} catch (Throwable $e) {
  $err = $e instanceof AppError ? $e : dbError($e);
  if ($err) {
    if ($err->status === 403 && $ctx->user && isset($ctx->db)) {
      try { if (rateLimit('aud403:' . $ctx->user['id'], 30, 3600000)) audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $ctx->cid, 'ip' => $ctx->ip, 'accion' => 'acceso_denegado', 'detalle' => ['ruta' => mb_substr("$metodo $ruta", 0, 160), 'motivo' => $err->codigo]]); } catch (Throwable) {}
    }
    $o = ['error' => $err->getMessage()]; if ($err->codigo !== null) $o['code'] = $err->codigo;
    enviar($err->status, $o);
  }
  $ref = bin2hex(random_bytes(4));
  error_log("[indiviso {$ref}] {$metodo} {$ruta} · " . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
  enviar(500, ['error' => "Error interno (ref. {$ref})." . (cfg('INDIVISO_DEBUG') === '1' ? ' ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() : '')]);
}
