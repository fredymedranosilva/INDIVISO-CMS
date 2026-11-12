<?php
// Enrutador para el servidor integrado de PHP (`php -S 127.0.0.1:8080 router.php`): pruebas locales y hospedajes sin .htaccess.
// Aplica las mismas reglas que .htaccess: la API va a api.php, solo se sirven archivos de la interfaz y nunca el código ni los datos.
declare(strict_types=1);

header_remove('X-Powered-By');
$crudo = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (preg_match('/%(?![0-9a-fA-F]{2})/', $crudo) || !mb_check_encoding(rawurldecode($crudo), 'UTF-8')) { http_response_code(400); header('Content-Type: text/plain; charset=utf-8'); echo 'Dirección inválida'; return true; }
$PUBLIC = is_dir(__DIR__ . '/../public') ? realpath(__DIR__ . '/../public') : __DIR__;
$ruta = rawurldecode((string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));

// Host permitido (INDIVISO_HOSTS) o, sin lista, solo localhost cuando se escucha en esta máquina
$host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$nombre = str_starts_with($host, '[') ? substr($host, 0, (int)strpos($host, ']') + 1) : explode(':', $host)[0];
$lista = array_filter(array_map('trim', explode(',', strtolower((string)getenv('INDIVISO_HOSTS')))));
$permitido = $host !== '' && strlen($host) <= 255 && ($lista ? (in_array($host, $lista, true) || in_array($nombre, $lista, true)) : in_array($nombre, ['localhost', '127.0.0.1', '[::1]'], true));
if (!$permitido) { http_response_code(421); header('Content-Type: text/plain; charset=utf-8'); echo 'Host no permitido'; return true; }

if (str_starts_with($ruta, '/api/') || $ruta === '/api') { require __DIR__ . '/api.php'; return true; }

$csp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
header("Content-Security-Policy: $csp");
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Resource-Policy: same-origin');
$metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($metodo !== 'GET' && $metodo !== 'HEAD') { http_response_code(405); header('Allow: GET, HEAD'); return true; }
if (str_contains($ruta, "\0")) { http_response_code(400); return true; }

$TYPES = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'mjs' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'svg' => 'image/svg+xml',
  'png' => 'image/png', 'ico' => 'image/x-icon', 'webmanifest' => 'application/manifest+json', 'woff2' => 'font/woff2', 'txt' => 'text/plain; charset=utf-8'];
if (str_ends_with($ruta, '/') || pathinfo($ruta, PATHINFO_EXTENSION) === '') $ruta = '/index.html';
$ext = strtolower(pathinfo($ruta, PATHINFO_EXTENSION));
$file = realpath($PUBLIC . $ruta);
$oculto = (bool)array_filter(explode('/', $ruta), fn($s) => str_starts_with($s, '.'));
$dentro = $file && str_starts_with($file, $PUBLIC . DIRECTORY_SEPARATOR) && !str_starts_with($file, $PUBLIC . DIRECTORY_SEPARATOR . 'app' . DIRECTORY_SEPARATOR) && !str_starts_with($file, $PUBLIC . DIRECTORY_SEPARATOR . 'datos');
if (!$dentro || !isset($TYPES[$ext]) || $oculto || !is_file($file)) { http_response_code(404); header('Content-Type: text/plain; charset=utf-8'); echo 'No encontrado'; return true; }
$etag = '"' . substr(hash_file('sha256', $file), 0, 22) . '"';
header('Content-Type: ' . $TYPES[$ext]);
header('Cache-Control: ' . ($ext === 'woff2' ? 'public, max-age=31536000, immutable' : 'no-cache'));
header("ETag: $etag");
if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); return true; }
header('Content-Length: ' . filesize($file));
if ($metodo === 'GET') readfile($file);
return true;
