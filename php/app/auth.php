<?php
// Autenticación: sesiones de servidor, bloqueo por intentos, 2FA TOTP con códigos de respaldo y CSRF (equivale a server/auth.mjs).
declare(strict_types=1);

const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 12 * 60 * 60 * 1000;
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const MAX_FALLOS_IP = 30;
const MAX_SESIONES = 8;
const TEMPORAL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'idv_s';
const MSG_BLOQUEO = 'Demasiados intentos fallidos. Espere 15 minutos e intente de nuevo.';

function ponerCookie(Ctx $ctx, string $value, int $maxAge): void {
  $name = $ctx->secure ? '__Host-' . COOKIE : COOKIE;
  header("Set-Cookie: {$name}={$value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={$maxAge}" . ($ctx->secure ? '; Secure' : ''), false);
}

function loadSession(Ctx $ctx): void {
  $raw = $_COOKIE[$ctx->secure ? '__Host-' . COOKIE : COOKIE] ?? null;
  if (!is_string($raw) || $raw === '' || strlen($raw) > 100) return;
  $s = $ctx->db->prepare('SELECT * FROM sesiones WHERE id = ?')->get(sha256($raw));
  $now = now_ms();
  if (!$s || $s['revocada'] || $s['expires_at'] < $now || $now - $s['last_seen'] > IDLE_MS) return;
  $u = $ctx->db->prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1')->get($s['usuario_id']);
  if (!$u) return;
  if ($now - $s['last_seen'] > 30000) $ctx->db->prepare('UPDATE sesiones SET last_seen = ? WHERE id = ?')->run($now, $s['id']);
  $ctx->sess = $s; $ctx->user = $u;
}

function checkCsrf(Ctx $ctx): void {
  $got = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
  if (!hash_equals((string)$ctx->sess['csrf'], $got)) fail(403, 'Token de seguridad inválido. Recargue la página.', 'CSRF');
}

function checkOrigin(Ctx $ctx): void {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($origin === '') return;
  $hosts = array_filter([$_SERVER['HTTP_HOST'] ?? '', trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_HOST'] ?? ''))[0])]);
  $p = parse_url($origin);
  $h = isset($p['host']) ? $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '') : null;
  if (!$h || !in_array(strtolower($h), array_map('strtolower', $hosts), true)) fail(403, 'Origen no permitido.', 'ORIGEN');
}

function crearSesion(Ctx $ctx, array $u, bool $mfaOk): void {
  $raw = token(32); $now = now_ms();
  $ctx->db->prepare('INSERT INTO sesiones (id, usuario_id, csrf, ip, ua, mfa_ok, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    ->run(sha256($raw), $u['id'], token(24), $ctx->ip, mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), $mfaOk ? 1 : 0, $now, $now, $now + ABS_MS);
  $activas = $ctx->db->prepare('SELECT id FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ? ORDER BY last_seen DESC')->all($u['id'], $now);
  foreach (array_slice($activas, MAX_SESIONES) as $s) $ctx->db->prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?')->run($s['id']);
  ponerCookie($ctx, $raw, intdiv(ABS_MS, 1000));
}

function revocarSesionesDe(DB $db, int $uid, ?string $excepto = null): int { return $db->prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0 AND id <> ?')->run($uid, $excepto ?? '')['changes']; }
function limpiarSesiones(DB $db): int { $l = now_ms() - 24 * 3600 * 1000; return $db->prepare('DELETE FROM sesiones WHERE expires_at < ? OR (revocada = 1 AND last_seen < ?)')->run($l, $l)['changes']; }

function membresias(DB $db, array $u): array {
  if ($u['superadmin']) return $db->prepare("SELECT id, nombre, ciudad, 'admin' AS rol FROM condominios WHERE activo = 1 ORDER BY nombre")->all();
  return $db->prepare('SELECT c.id, c.nombre, c.ciudad, m.rol FROM membresias m JOIN condominios c ON c.id = m.condominio_id WHERE m.usuario_id = ? AND c.activo = 1 ORDER BY c.nombre')->all($u['id']);
}

function verificarSegundoFactor(Ctx $ctx, $code, bool $permitirRespaldo = true): ?array {
  $u = $ctx->user; $s = trim((string)($code ?? ''));
  if (preg_match('/^\d{6}$/', $s)) {
    $secreto = null;
    try { $secreto = abrir($u['totp_secret']); } catch (Throwable) { error_log('[2fa] no se pudo descifrar el secreto del usuario ' . $u['id']); }
    $step = $secreto ? verifyTotp($secreto, $s, $u['totp_ultimo_paso']) : null;
    return $step ? ['step' => $step] : null;
  }
  if (!$permitirRespaldo) return null;
  $n = normalizarCodigo($s);
  if (strlen($n) !== 8) return null;
  $r = $ctx->db->prepare('SELECT id FROM totp_respaldo WHERE usuario_id = ? AND hash = ? AND usado_at IS NULL')->get($u['id'], sha256($n));
  return $r ? ['respaldo' => $r['id']] : null;
}
function consumirSegundoFactor(Ctx $ctx, array $f): void {
  if (!empty($f['step'])) $ctx->db->prepare('UPDATE usuarios SET totp_ultimo_paso = ? WHERE id = ?')->run($f['step'], $ctx->user['id']);
  if (!empty($f['respaldo'])) {
    $ctx->db->prepare('UPDATE totp_respaldo SET usado_at = ? WHERE id = ?')->run(now_ms(), $f['respaldo']);
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'mfa_codigo_respaldo_usado']);
  }
}
function generarCodigos(Ctx $ctx): array {
  $codigos = nuevosCodigosRespaldo();
  $ctx->db->prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?')->run($ctx->user['id']);
  foreach ($codigos as $c) $ctx->db->prepare('INSERT INTO totp_respaldo (usuario_id, hash, created_at) VALUES (?,?,?)')->run($ctx->user['id'], sha256(normalizarCodigo($c)), now_ms());
  return $codigos;
}
function exigirIntento(Ctx $ctx, string $clave): void { if (limiteExcedido("{$clave}:{$ctx->user['id']}", MAX_INTENTOS)) fail(429, MSG_BLOQUEO); }
function fallo(Ctx $ctx, string $clave, string $accion, string $msg, int $status = 401): never {
  rateLimit("{$clave}:{$ctx->user['id']}", MAX_INTENTOS, BLOQUEO_MS);
  audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => $accion]);
  fail($status, $msg);
}

function authRoutes(): array { return [
  ['POST', '/api/auth/login', ['publico' => true], function (Ctx $ctx) {
    $kIp = 'login:' . $ctx->ip;
    if (limiteExcedido($kIp, MAX_FALLOS_IP)) fail(429, 'Demasiados intentos fallidos desde esta conexión. Espere 15 minutos.');
    $b = v($ctx->body, ['email' => 'email', 'password' => 'str|max128']);
    $kEmail = 'login-email:' . sha256($b['email']);
    if (limiteExcedido($kEmail, MAX_INTENTOS)) fail(429, MSG_BLOQUEO);
    $u = $ctx->db->prepare('SELECT * FROM usuarios WHERE email = ?')->get($b['email']);
    $now = now_ms();
    $ok = verifyPassword($b['password'], $u['pass_hash'] ?? dummyHash());
    $bloqueada = $u && $u['bloqueado_hasta'] && $u['bloqueado_hasta'] > $now;
    if (!$u || !$u['activo'] || $bloqueada || !$ok) {
      rateLimit($kEmail, MAX_INTENTOS, BLOQUEO_MS);
      rateLimit($kIp, MAX_FALLOS_IP, BLOQUEO_MS);
      tx($ctx->db, function () use ($ctx, $u, $ok, $bloqueada, $now, $b) {
        if ($u && !$ok && !$bloqueada) {
          $n = $u['intentos_fallidos'] + 1;
          $ctx->db->prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?')->run($n >= MAX_INTENTOS ? 0 : $n, $n >= MAX_INTENTOS ? $now + BLOQUEO_MS : null, $u['id']);
          if ($n >= MAX_INTENTOS) audit($ctx->db, ['usuario_id' => $u['id'], 'ip' => $ctx->ip, 'accion' => 'cuenta_bloqueada']);
        }
        audit($ctx->db, ['usuario_id' => $u['id'] ?? null, 'ip' => $ctx->ip, 'accion' => 'login_fallido', 'detalle' => ['email' => $b['email']]]);
      });
      if ($bloqueada || limiteExcedido($kEmail, MAX_INTENTOS)) fail(429, MSG_BLOQUEO);
      fail(401, 'Correo o contraseña incorrectos.');
    }
    if ($u['debe_cambiar_pass'] && $u['pass_temporal_hasta'] && $u['pass_temporal_hasta'] < $now) {
      audit($ctx->db, ['usuario_id' => $u['id'], 'ip' => $ctx->ip, 'accion' => 'login_temporal_vencida']);
      fail(401, 'Su contraseña temporal venció. Pida a la administración que la restablezca.');
    }
    limiteLimpiar($kEmail);
    tx($ctx->db, function () use ($ctx, $u, $now) {
      $ctx->db->prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?')->run($now, $u['id']);
      crearSesion($ctx, $u, !$u['totp_activo']);
      audit($ctx->db, ['usuario_id' => $u['id'], 'ip' => $ctx->ip, 'accion' => 'login']);
    });
    return ['mfa' => (bool)$u['totp_activo'], 'cambiar_password' => (bool)$u['debe_cambiar_pass']];
  }],

  ['POST', '/api/auth/mfa', ['mfaPendiente' => true], function (Ctx $ctx) {
    if (!rateLimit('mfa:' . $ctx->sess['id'], 6, 5 * 60 * 1000)) fail(429, 'Demasiados intentos.');
    exigirIntento($ctx, 'mfa-u');
    $code = v($ctx->body, ['code' => 'str|max12'])['code'];
    if (!$ctx->user['totp_activo']) fail(400, 'La verificación en dos pasos no está activa.');
    $f = verificarSegundoFactor($ctx, $code);
    if (!$f) fallo($ctx, 'mfa-u', 'mfa_fallido', 'Código incorrecto.');
    limiteLimpiar("mfa-u:{$ctx->user['id']}");
    tx($ctx->db, function () use ($ctx, $f) {
      consumirSegundoFactor($ctx, $f);
      $ctx->db->prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?')->run($ctx->sess['id']);
      crearSesion($ctx, $ctx->user, true);
    });
    return ['ok' => true, 'respaldo' => !empty($f['respaldo'])];
  }],

  ['POST', '/api/auth/logout', ['mfaPendiente' => true, 'cambioPendiente' => true], function (Ctx $ctx) {
    $ctx->db->prepare('UPDATE sesiones SET revocada = 1 WHERE id = ?')->run($ctx->sess['id']);
    ponerCookie($ctx, '', 0);
    return ['ok' => true];
  }],

  ['GET', '/api/auth/me', ['mfaPendiente' => true, 'cambioPendiente' => true], fn(Ctx $ctx) => [
    'mfa_pendiente' => !$ctx->sess['mfa_ok'],
    'cambiar_password' => (bool)$ctx->user['debe_cambiar_pass'],
    'csrf' => $ctx->sess['csrf'],
    'user' => ['id' => $ctx->user['id'], 'nombre' => $ctx->user['nombre'], 'email' => $ctx->user['email'], 'superadmin' => (bool)$ctx->user['superadmin'], 'totp' => (bool)$ctx->user['totp_activo'],
      'codigos_respaldo' => $ctx->sess['mfa_ok'] && $ctx->user['totp_activo'] ? $ctx->db->prepare('SELECT COUNT(*) n FROM totp_respaldo WHERE usuario_id = ? AND usado_at IS NULL')->get($ctx->user['id'])['n'] : null],
    'condominios' => $ctx->sess['mfa_ok'] && !$ctx->user['debe_cambiar_pass'] ? membresias($ctx->db, $ctx->user) : [],
  ]],

  ['POST', '/api/auth/password', ['cambioPendiente' => true], function (Ctx $ctx) {
    exigirIntento($ctx, 'pass');
    $b = v($ctx->body, ['actual' => 'str|max128', 'nueva' => 'str|max128']);
    if (!verifyPassword($b['actual'], $ctx->user['pass_hash'])) fallo($ctx, 'pass', 'cambio_password_fallido', 'La contraseña actual no es correcta.');
    if ($p = passwordProblem($b['nueva'], $ctx->user['email'])) fail(400, $p);
    if ($b['nueva'] === $b['actual']) fail(400, 'La contraseña nueva debe ser distinta de la actual.');
    limiteLimpiar("pass:{$ctx->user['id']}");
    tx($ctx->db, function () use ($ctx, $b) {
      $ctx->db->prepare('UPDATE usuarios SET pass_hash = ?, pass_cambiado_at = ?, debe_cambiar_pass = 0, pass_temporal_hasta = NULL WHERE id = ?')->run(hashPassword($b['nueva']), now_ms(), $ctx->user['id']);
      revocarSesionesDe($ctx->db, $ctx->user['id'], $ctx->sess['id']);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'cambio_password']);
    });
    return ['ok' => true];
  }],

  ['POST', '/api/auth/totp/iniciar', [], function (Ctx $ctx) {
    if ($ctx->user['totp_activo']) fail(409, 'La verificación en dos pasos ya está activa.');
    $secret = newTotpSecret();
    $ctx->db->prepare('UPDATE usuarios SET totp_secret = ? WHERE id = ?')->run(sellar($secret), $ctx->user['id']);
    return ['secret' => $secret, 'uri' => 'otpauth://totp/Indiviso%20CMS:' . rawurlencode($ctx->user['email']) . "?secret={$secret}&issuer=Indiviso%20CMS&digits=6&period=30"];
  }],
  ['POST', '/api/auth/totp/activar', [], function (Ctx $ctx) {
    exigirIntento($ctx, 'totp');
    $code = v($ctx->body, ['code' => 'str|max6'])['code'];
    if ($ctx->user['totp_activo']) fail(409, 'La verificación en dos pasos ya está activa.');
    if (!$ctx->user['totp_secret']) fail(400, 'Inicie primero la configuración.');
    $step = verifyTotp(abrir($ctx->user['totp_secret']), $code, 0);
    if (!$step) fallo($ctx, 'totp', 'mfa_activacion_fallida', 'Código incorrecto. Verifique la hora de su teléfono.', 400);
    return tx($ctx->db, function () use ($ctx, $step) {
      $ctx->db->prepare('UPDATE usuarios SET totp_activo = 1, totp_ultimo_paso = ? WHERE id = ?')->run($step, $ctx->user['id']);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'mfa_activado']);
      return ['ok' => true, 'codigos' => generarCodigos($ctx)];
    });
  }],
  ['POST', '/api/auth/totp/desactivar', [], function (Ctx $ctx) {
    exigirIntento($ctx, 'totp');
    $b = v($ctx->body, ['password' => 'str|max128', 'code' => 'str|max12']);
    if (!$ctx->user['totp_activo']) fail(409, 'La verificación en dos pasos no está activa.');
    $f = verifyPassword($b['password'], $ctx->user['pass_hash']) ? verificarSegundoFactor($ctx, $b['code']) : null;
    if (!$f) fallo($ctx, 'totp', 'mfa_desactivacion_fallida', 'Contraseña o código incorrectos.');
    tx($ctx->db, function () use ($ctx) {
      $ctx->db->prepare('UPDATE usuarios SET totp_activo = 0, totp_secret = NULL, totp_ultimo_paso = NULL WHERE id = ?')->run($ctx->user['id']);
      $ctx->db->prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?')->run($ctx->user['id']);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'mfa_desactivado']);
    });
    return ['ok' => true];
  }],
  ['POST', '/api/auth/totp/codigos', [], function (Ctx $ctx) {
    exigirIntento($ctx, 'totp');
    $b = v($ctx->body, ['password' => 'str|max128', 'code' => 'str|max6']);
    if (!$ctx->user['totp_activo']) fail(409, 'Active primero la verificación en dos pasos.');
    $f = verifyPassword($b['password'], $ctx->user['pass_hash']) ? verificarSegundoFactor($ctx, $b['code'], false) : null;
    if (!$f) fallo($ctx, 'totp', 'mfa_codigos_fallido', 'Contraseña o código incorrectos.');
    return tx($ctx->db, function () use ($ctx, $f) {
      consumirSegundoFactor($ctx, $f);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'mfa_codigos_regenerados']);
      return ['codigos' => generarCodigos($ctx)];
    });
  }],

  ['GET', '/api/auth/sesiones', [], fn(Ctx $ctx) => array_map(fn($s) => $s + ['actual' => str_starts_with($ctx->sess['id'], $s['id'])],
    $ctx->db->prepare('SELECT substr(id, 1, 12) AS id, ip, ua, created_at, last_seen FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ? ORDER BY last_seen DESC')->all($ctx->user['id'], now_ms()))],
  ['POST', '/api/auth/sesiones/:sid/revocar', [], function (Ctx $ctx) {
    if (!preg_match('/^[0-9a-f]{12}$/', $ctx->params['sid'])) fail(400, 'Sesión inválida.');
    $ctx->db->prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND substr(id, 1, 12) = ?')->run($ctx->user['id'], $ctx->params['sid']);
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'sesion_revocada']);
    return ['ok' => true];
  }],
  ['POST', '/api/auth/sesiones/cerrar-otras', [], function (Ctx $ctx) {
    $n = revocarSesionesDe($ctx->db, $ctx->user['id'], $ctx->sess['id']);
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'sesiones_cerradas', 'detalle' => ['cerradas' => $n]]);
    return ['cerradas' => $n];
  }],
]; }
