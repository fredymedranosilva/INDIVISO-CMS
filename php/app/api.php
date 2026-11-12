<?php
// API por condominio (equivale a server/api.mjs). Cada ruta declara su permiso; cada escritura corre en una transacción
// y deja rastro en la bitácora encadenada dentro de la misma transacción.
declare(strict_types=1);

const VERSION = '2.0.0';
const PERMS = ['ver' => ['admin', 'contador', 'comite'], 'capturar' => ['admin', 'contador'], 'aprobar' => ['admin', 'comite'], 'cancelar' => ['admin'], 'cerrar' => ['admin'],
  'config' => ['admin'], 'usuarios' => ['admin'], 'auditoria' => ['admin', 'comite'], 'residente' => ['residente']];

final class Ctx {
  public DB $db; public string $ip = ''; public bool $secure = false; public array $query = []; public array $params = []; public array $body = [];
  public ?array $user = null; public ?array $sess = null; public ?int $cid = null; public ?string $rol = null; public $auditDetalle = null; public bool $hayDetalle = false;
}
function rolEn(Ctx $ctx, int $cid): ?string {
  if ($ctx->user['superadmin']) return 'admin';
  return $ctx->db->prepare('SELECT rol FROM membresias WHERE usuario_id = ? AND condominio_id = ?')->get($ctx->user['id'], $cid)['rol'] ?? null;
}
function exigir(Ctx $ctx, string $perm): void { if (!in_array($ctx->rol, PERMS[$perm], true)) fail(403, 'No tiene permiso para esta operación.'); }
function resolverCondominio(Ctx $ctx, ?string $perm): void {
  if (!preg_match('/^\d+$/', $ctx->params['cid'])) fail(400, 'Condominio inválido.');
  $ctx->cid = (int)$ctx->params['cid'];
  $ctx->rol = rolEn($ctx, $ctx->cid);
  if (!$ctx->rol || !$ctx->db->prepare('SELECT 1 FROM condominios WHERE id = ? AND activo = 1')->get($ctx->cid)) fail(404, 'Condominio no encontrado');
  if ($perm) exigir($ctx, $perm);
}
function sinSecretos($b) {
  if (!is_array($b) || !$b) return null;
  foreach (['password', 'nueva', 'actual', 'contenido', 'base64', 'filas'] as $k) if (array_key_exists($k, $b)) $b[$k] = is_array($b[$k]) ? '[' . count($b[$k]) . ']' : '[omitido]';
  return $b;
}
function escribir(Ctx $ctx, string $accion, string $entidad, callable $fn) {
  return tx($ctx->db, function () use ($ctx, $accion, $entidad, $fn) {
    $r = $fn();
    $id = is_int($r) ? $r : (is_array($r) ? ($r['id'] ?? null) : null);
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $ctx->cid, 'ip' => $ctx->ip, 'accion' => $accion, 'entidad' => $entidad, 'entidad_id' => $id,
      'detalle' => $ctx->hayDetalle ? $ctx->auditDetalle : sinSecretos($ctx->body)]);
    return $r;
  });
}
function detalle(Ctx $ctx, $d): void { $ctx->auditDetalle = $d; $ctx->hayDetalle = true; }
function q(Ctx $ctx, string $k, $def = null) { $v = $ctx->query[$k] ?? null; return is_string($v) ? $v : $def; }
function qPeriodo(Ctx $ctx, string $k, ?string $def = null): string { $p = q($ctx, $k, $def); if (!is_string($p) || !preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $p)) fail(400, "Periodo «{$k}» inválido."); return $p; }
function qFecha(Ctx $ctx, string $k, ?string $def = null): string { $p = q($ctx, $k, $def); if (!isDate($p)) fail(400, "Fecha «{$k}» inválida."); return $p; }
function qInt(Ctx $ctx, string $k, ?int $def = null): ?int { $s = q($ctx, $k); if ($s === null || $s === '') return $def; if (!preg_match('/^\d+$/', $s)) fail(400, "«{$k}» inválido."); return (int)$s; }
function qRango(Ctx $ctx): array {
  $anio = qInt($ctx, 'anio', (int)substr(hoy(), 0, 4)); $mes = qInt($ctx, 'mes', (int)substr(hoy(), 5, 2));
  if ($anio < 2000 || $anio > 2100 || $mes > 12) fail(400, 'Periodo inválido.');
  $dP = $mes ? $anio . '-' . pad2($mes) : "{$anio}-01";
  $hP = $mes ? $dP : "{$anio}-12";
  if (!$mes && $hP > periodoActual() && $dP <= periodoActual()) $hP = periodoActual();
  return ['anio' => $anio, 'mes' => $mes, 'desdeP' => $dP, 'hastaP' => $hP, 'desde' => "{$dP}-01", 'hasta' => finDeMes($hP)];
}
function idParam(Ctx $ctx, string $k = 'id'): int { $s = $ctx->params[$k] ?? ''; if (!preg_match('/^\d+$/', $s)) fail(400, 'Identificador inválido.'); return (int)$s; }
function unidadesDeResidente(Ctx $ctx): array {
  $m = $ctx->db->prepare('SELECT persona_id FROM membresias WHERE usuario_id = ? AND condominio_id = ?')->get($ctx->user['id'], $ctx->cid);
  if (empty($m['persona_id'])) return [];
  return $ctx->db->prepare('SELECT u.* FROM unidad_personas up JOIN unidades u ON u.id = up.unidad_id WHERE up.persona_id = ? AND u.condominio_id = ? GROUP BY u.id')->all($m['persona_id'], $ctx->cid);
}
function unidadDelCondo(Ctx $ctx, $uid): array { return $ctx->db->prepare('SELECT * FROM unidades WHERE id = ? AND condominio_id = ?')->get($uid, $ctx->cid) ?? fail(404, 'Unidad no encontrada'); }
function soloSuper(Ctx $ctx): void { if (!$ctx->user['superadmin']) fail(403, 'Solo el superadministrador tiene acceso a la administración general.'); }
function likeSeguro(string $t): string { return '%' . preg_replace('/([\\\\%_])/', '\\\\$1', $t) . '%'; }
function limiteUsuario(Ctx $ctx, string $k, int $n = 10): bool { return rateLimit("{$k}:{$ctx->user['id']}", $n, 3600000); }

// ---------- Archivos ----------
function tipoArchivo(string $b): ?string {
  if (substr($b, 0, 5) === '%PDF-') return 'application/pdf';
  if (substr($b, 0, 8) === "\x89PNG\r\n\x1a\n") return 'image/png';
  if (substr($b, 0, 3) === "\xff\xd8\xff") return 'image/jpeg';
  if (preg_match('/^(\xEF\xBB\xBF)?\s*<(\?xml|cfdi:Comprobante)/', substr($b, 0, 200))) return 'application/xml';
  return null;
}
function guardarArchivo(Ctx $ctx, $nombre, $b64, bool $soloImagen = false): int {
  if (!is_string($b64) || strlen($b64) > 7000000) fail(413, 'El archivo excede 5 MB.');
  if (!preg_match('/^[A-Za-z0-9+\/]*={0,2}$/', $b64)) fail(400, 'Archivo inválido.');
  $buf = base64_decode($b64, true);
  if ($buf === false || $buf === '') fail(400, 'Archivo vacío.');
  $tipo = tipoArchivo($buf) ?? fail(415, 'Solo se aceptan PDF, PNG, JPG o XML de CFDI.');
  if ($soloImagen && !str_starts_with($tipo, 'image/')) fail(415, 'El logotipo debe ser una imagen PNG o JPG.');
  if ($soloImagen && strlen($buf) > 1000000) fail(413, 'El logotipo excede 1 MB.');
  $h = hash('sha256', $buf);
  $prev = $ctx->db->prepare('SELECT id FROM archivos WHERE condominio_id = ? AND sha256 = ?')->get($ctx->cid, $h);
  if ($prev) return $prev['id'];
  $path = files_dir() . "/$h";
  if (!is_file($path)) { file_put_contents($path, $buf); @chmod($path, 0600); }
  $limpio = mslice(preg_replace('/[^\p{L}\p{N} ._-]/u', '_', (string)($nombre ?: 'archivo')), 0, 120);
  return $ctx->db->prepare('INSERT INTO archivos (condominio_id, sha256, nombre, mime, bytes, created_by, created_at) VALUES (?,?,?,?,?,?,?)')->run($ctx->cid, $h, $limpio, $tipo, strlen($buf), $ctx->user['id'], now_ms())['lastInsertRowid'];
}
function leerCfdi(string $xml): array {
  $attr = function ($tag, $a) use ($xml) { return preg_match('/<(?:\w+:)?' . $tag . '\b[^>]*?\s' . $a . '="([^"]*)"/i', $xml, $m) ? str_replace(['&amp;', '&quot;'], ['&', '"'], $m[1]) : null; };
  $cents = fn($s) => $s === null ? null : jround((float)$s * 100);
  $uuid = $attr('TimbreFiscalDigital', 'UUID') ?? fail(400, 'El XML no contiene un timbre fiscal (UUID).');
  return ['uuid' => strtoupper($uuid), 'fecha' => substr((string)$attr('Comprobante', 'Fecha'), 0, 10) ?: null, 'serie' => $attr('Comprobante', 'Serie'), 'folio' => $attr('Comprobante', 'Folio'),
    'subtotal_cents' => $cents($attr('Comprobante', 'SubTotal')), 'total_cents' => $cents($attr('Comprobante', 'Total')),
    'iva_cents' => $cents($attr('Impuestos', 'TotalImpuestosTrasladados')) ?: 0, 'retenciones_cents' => $cents($attr('Impuestos', 'TotalImpuestosRetenidos')) ?: 0,
    'emisor_rfc' => $attr('Emisor', 'Rfc'), 'emisor_nombre' => $attr('Emisor', 'Nombre'), 'receptor_rfc' => $attr('Receptor', 'Rfc')];
}
function csvSeguro(array $rows, array $cols): string {
  $cell = function ($x) { if ($x === null) return ''; $s = (string)$x; if (is_string($x) && preg_match('/^[=+\-@\t\r]/', $s)) $s = "'" . $s; return preg_match('/[",\n;]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s; };
  $out = [implode(',', array_column($cols, 0))];
  foreach ($rows as $r) $out[] = implode(',', array_map(fn($c) => $cell($c[1]($r)), $cols));
  return "\xEF\xBB\xBF" . implode("\r\n", $out);
}
function pesosCsv($c): string { return number_format(($c ?? 0) / 100, 2, '.', ''); }
function datosCondo(array $c): array {
  return ['id' => $c['id'], 'nombre' => $c['nombre'], 'razon_social' => $c['razon_social'], 'rfc' => $c['rfc'], 'direccion' => $c['direccion'], 'ciudad' => $c['ciudad'], 'logo' => (bool)$c['logo_archivo_id'],
    'dia_vencimiento' => $c['dia_vencimiento'], 'dias_gracia' => $c['dias_gracia'], 'tasa_recargo_bp' => $c['tasa_recargo_bp'], 'recargo_modo' => $c['recargo_modo'], 'recargo_fijo_cents' => $c['recargo_fijo_cents'],
    'pronto_pago_bp' => $c['pronto_pago_bp'], 'pronto_pago_dia' => $c['pronto_pago_dia']];
}
function reciboDe(Ctx $ctx, array $p): array {
  $apl = $ctx->db->prepare('SELECT a.monto_cents, a.revertida, c.concepto, c.periodo FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.pago_id = ? ORDER BY a.id')->all($p['id']);
  $prop = $ctx->db->prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'")->get($p['unidad_id'])['n'];
  return ['condominio' => datosCondo(condo($ctx->db, $ctx->cid)), 'pago' => $p, 'propietario' => $prop, 'aplicaciones' => $apl,
    'sello' => strtoupper(substr(sha256("{$ctx->cid}|{$p['id']}|{$p['folio']}|{$p['monto_cents']}|{$p['fecha']}|{$p['poliza_id']}"), 0, 24))];
}
function usuarioAdministrable(Ctx $ctx, int $uid): array {
  if ($uid === $ctx->user['id']) fail(400, 'Use «Mi cuenta» para su propia contraseña y verificación en dos pasos.');
  $u = $ctx->db->prepare('SELECT u.* FROM usuarios u JOIN membresias m ON m.usuario_id = u.id WHERE u.id = ? AND m.condominio_id = ?')->get($uid, $ctx->cid) ?? fail(404, 'Usuario no encontrado');
  if ($ctx->user['superadmin']) return $u;
  if ($u['superadmin']) fail(403, 'Solo el superadministrador puede restablecer esta cuenta.');
  $aj = $ctx->db->prepare("SELECT COUNT(*) n FROM membresias m WHERE m.usuario_id = ? AND NOT EXISTS (SELECT 1 FROM membresias a WHERE a.usuario_id = ? AND a.condominio_id = m.condominio_id AND a.rol = 'admin')")->get($u['id'], $ctx->user['id'])['n'];
  if ($aj) fail(403, 'Este usuario tiene acceso a otros condominios: solo el superadministrador puede restablecer su cuenta.');
  return $u;
}
function referenciaPago(DB $db, int $cid, string $clave): string {
  $base = substr(str_pad((string)$cid, 3, '0', STR_PAD_LEFT) . strtoupper(preg_replace('/[^A-Z0-9]/i', '', $clave)), 0, 14);
  $num = ''; foreach (str_split($base) as $c) $num .= ctype_digit($c) ? $c : (string)(ord($c) - 55);
  $r = 0; foreach (str_split($num) as $d) $r = ($r * 10 + (int)$d) % 97;
  return $base . str_pad((string)(98 - ($r * 100) % 97), 2, '0', STR_PAD_LEFT);
}
function tempPass(): string { return token(12) . 'aA1!'; }
const PAGO_BODY = ['unidad_id' => 'int|min1', 'fecha' => 'date', 'monto_cents' => 'cents', 'metodo' => 'enum|transferencia|deposito|efectivo|tarjeta|cheque|domiciliacion',
  'referencia' => 'str|opt|max60', 'cuenta_banco_id' => 'int|opt', 'comprobante_id' => 'int|opt', 'notas' => 'str|opt|max300', 'idem_key' => 'key', 'confirmar_duplicado' => 'bool|opt'];
function soloSuperRespaldos(Ctx $ctx): void { if (!$ctx->user['superadmin']) fail(403, 'Solo el superadministrador gestiona respaldos.'); }
function bancosOperacion(Ctx $ctx): array { return $ctx->db->prepare("SELECT banco, nombre, clabe_mask FROM cuentas_banco WHERE condominio_id = ? AND activo = 1 AND fondo = 'operacion'")->all($ctx->cid); }
function resi(Ctx $ctx, int $uid): void { if ($ctx->rol === 'residente') { if (!some(unidadesDeResidente($ctx), fn($u) => $u['id'] === $uid)) fail(404, 'Unidad no encontrada'); } else exigir($ctx, 'ver'); }

function apiRoutes(): array { $C = '/api/c/:cid'; return [
  // ===== Global =====
  ['GET', '/api/consolidado', [], function (Ctx $ctx) {
    $p = qPeriodo($ctx, 'periodo', periodoActual());
    return array_map(function ($c) use ($ctx, $p) { $t = tablero($ctx->db, $c['id'], $p); return ['id' => $c['id'], 'nombre' => $c['nombre'], 'ciudad' => $c['ciudad']] + $t['kpis'] + ['pendientes' => $t['pendientes'], 'serie' => $t['serie']]; },
      filt(membresias($ctx->db, $ctx->user), fn($c) => in_array($c['rol'], PERMS['ver'], true)));
  }],
  ['POST', '/api/condominios', [], function (Ctx $ctx) {
    if (!$ctx->user['superadmin']) fail(403, 'Solo el superadministrador crea condominios.');
    $b = v($ctx->body, ['nombre' => 'str|max120', 'razon_social' => 'str|opt|max160', 'rfc' => 'rfc|opt', 'direccion' => 'str|opt|max250', 'ciudad' => 'str|opt|max80']);
    return tx($ctx->db, function () use ($ctx, $b) { $id = crearCondominio($ctx->db, $b, $ctx->user); audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $id, 'ip' => $ctx->ip, 'accion' => 'condominio_creado', 'entidad' => 'condominio', 'entidad_id' => $id, 'detalle' => $b]); return ['id' => $id]; });
  }],
  ['GET', '/api/admin/respaldos', [], function (Ctx $ctx) { soloSuperRespaldos($ctx); return $ctx->db->prepare('SELECT * FROM respaldos ORDER BY id DESC LIMIT 100')->all(); }],
  ['POST', '/api/admin/respaldos', [], function (Ctx $ctx) { soloSuperRespaldos($ctx); $r = crearRespaldo($ctx->db, 'manual'); audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'respaldo_manual', 'detalle' => $r]); return $r; }],
  ['POST', '/api/admin/respaldos/:f/verificar', [], function (Ctx $ctx) { soloSuperRespaldos($ctx); $r = verificarRespaldo($ctx->params['f']); audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'respaldo_verificado', 'detalle' => ['archivo' => $ctx->params['f'], 'ok' => $r['ok']]]); return $r; }],
  ['GET', '/api/admin/respaldos/:f', [], function (Ctx $ctx) {
    soloSuperRespaldos($ctx);
    $p = rutaRespaldo($ctx->params['f']) ?? fail(404, 'Respaldo no encontrado');
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'respaldo_descargado', 'detalle' => ['archivo' => $ctx->params['f']]]);
    return ['__file' => ['path' => $p, 'name' => $ctx->params['f'], 'mime' => 'application/octet-stream']];
  }],
  ['GET', '/api/admin/auditoria/verificar', [], function (Ctx $ctx) {
    if (!$ctx->user['superadmin'] && !some(membresias($ctx->db, $ctx->user), fn($m) => in_array($m['rol'], PERMS['auditoria'], true))) fail(403, 'Sin permiso.');
    return verifyAuditChain($ctx->db);
  }],
  ['GET', '/api/admin/condominios', [], function (Ctx $ctx) { soloSuper($ctx); return $ctx->db->prepare('SELECT c.id, c.nombre, c.razon_social, c.rfc, c.ciudad, c.activo, c.created_at,
      (SELECT COUNT(*) FROM unidades u WHERE u.condominio_id = c.id AND u.activo = 1) AS unidades, (SELECT COUNT(*) FROM membresias m WHERE m.condominio_id = c.id) AS usuarios,
      (SELECT MAX(ts) FROM auditoria a WHERE a.condominio_id = c.id) AS ultima_actividad FROM condominios c ORDER BY c.activo DESC, c.nombre')->all(); }],
  ['PUT', '/api/admin/condominios/:id', [], function (Ctx $ctx) {
    soloSuper($ctx); $id = idParam($ctx); $b = v($ctx->body, ['activo' => 'bool']);
    $ctx->db->prepare('SELECT 1 FROM condominios WHERE id = ?')->get($id) ?? fail(404, 'Condominio no encontrado');
    return tx($ctx->db, function () use ($ctx, $id, $b) { $ctx->db->prepare('UPDATE condominios SET activo = ? WHERE id = ?')->run($b['activo'] ? 1 : 0, $id);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $id, 'ip' => $ctx->ip, 'accion' => $b['activo'] ? 'condominio_reactivado' : 'condominio_archivado', 'entidad' => 'condominio', 'entidad_id' => $id]); return ['id' => $id]; });
  }],
  ['GET', '/api/admin/usuarios', [], function (Ctx $ctx) {
    soloSuper($ctx);
    $ms = $ctx->db->prepare('SELECT m.usuario_id, m.rol, c.id AS condominio_id, c.nombre FROM membresias m JOIN condominios c ON c.id = m.condominio_id ORDER BY c.nombre')->all();
    return array_map(fn($u) => $u + ['sesiones' => $ctx->db->prepare('SELECT COUNT(*) n FROM sesiones WHERE usuario_id = ? AND revocada = 0 AND expires_at > ?')->get($u['id'], now_ms())['n'],
      'accesos' => array_map(fn($m) => ['condominio_id' => $m['condominio_id'], 'condominio' => $m['nombre'], 'rol' => $m['rol']], filt($ms, fn($m) => $m['usuario_id'] === $u['id']))],
      $ctx->db->prepare('SELECT id, nombre, email, superadmin, activo, totp_activo, ultimo_acceso, bloqueado_hasta, debe_cambiar_pass, created_at FROM usuarios ORDER BY activo DESC, nombre')->all());
  }],
  ['PUT', '/api/admin/usuarios/:id', [], function (Ctx $ctx) {
    soloSuper($ctx); $uid = idParam($ctx); $b = v($ctx->body, ['activo' => 'bool']);
    if ($uid === $ctx->user['id']) fail(400, 'No puede desactivar su propia cuenta.');
    $u = $ctx->db->prepare('SELECT id, email FROM usuarios WHERE id = ?')->get($uid) ?? fail(404, 'Usuario no encontrado');
    return tx($ctx->db, function () use ($ctx, $uid, $b, $u) {
      $ctx->db->prepare('UPDATE usuarios SET activo = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?')->run($b['activo'] ? 1 : 0, $uid);
      if (!$b['activo']) revocarSesionesDe($ctx->db, $uid);
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => $b['activo'] ? 'usuario_reactivado' : 'usuario_desactivado', 'entidad' => 'usuario', 'entidad_id' => $uid, 'detalle' => ['usuario' => $u['email']]]);
      return ['id' => $uid];
    });
  }],
  ['POST', '/api/admin/usuarios/:id/:accion', [], function (Ctx $ctx) {
    soloSuper($ctx); $uid = idParam($ctx); $accion = $ctx->params['accion'];
    if ($uid === $ctx->user['id']) fail(400, 'Use «Mi cuenta» para su propia contraseña, sesiones y verificación en dos pasos.');
    $u = $ctx->db->prepare('SELECT id, email FROM usuarios WHERE id = ?')->get($uid) ?? fail(404, 'Usuario no encontrado');
    return tx($ctx->db, function () use ($ctx, $uid, $accion, $u) {
      $out = ['id' => $uid];
      if ($accion === 'restablecer') { $t = tempPass(); $ctx->db->prepare('UPDATE usuarios SET pass_hash = ?, debe_cambiar_pass = 1, pass_temporal_hasta = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?')->run(hashPassword($t), now_ms() + TEMPORAL_MS, $uid); revocarSesionesDe($ctx->db, $uid); $out['password_temporal'] = $t; }
      elseif ($accion === 'restablecer-2fa') { $ctx->db->prepare('UPDATE usuarios SET totp_activo = 0, totp_secret = NULL, totp_ultimo_paso = NULL WHERE id = ?')->run($uid); $ctx->db->prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?')->run($uid); revocarSesionesDe($ctx->db, $uid); }
      elseif ($accion === 'cerrar-sesiones') $out['cerradas'] = revocarSesionesDe($ctx->db, $uid);
      elseif ($accion === 'desbloquear') $ctx->db->prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?')->run($uid);
      else fail(404, 'Acción desconocida');
      audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'ip' => $ctx->ip, 'accion' => 'admin_' . str_replace('-', '_', $accion), 'entidad' => 'usuario', 'entidad_id' => $uid, 'detalle' => ['usuario' => $u['email']]]);
      return $out;
    });
  }],
  ['GET', '/api/admin/auditoria', [], function (Ctx $ctx) {
    soloSuper($ctx);
    $lim = min(qInt($ctx, 'limit', 200), 1000); $off = qInt($ctx, 'offset', 0);
    $w = ['1 = 1']; $a = [];
    if (q($ctx, 'accion')) { $w[] = "a.accion LIKE ? ESCAPE '\\'"; $a[] = likeSeguro(mslice(q($ctx, 'accion'), 0, 40)); }
    if (q($ctx, 'usuario')) { $w[] = 'a.usuario_id = ?'; $a[] = qInt($ctx, 'usuario'); }
    if (q($ctx, 'condominio')) { $w[] = 'a.condominio_id = ?'; $a[] = qInt($ctx, 'condominio'); }
    if (q($ctx, 'seguridad') === '1') $w[] = "a.accion IN ('login_fallido','cuenta_bloqueada','acceso_denegado','mfa_fallido','login_temporal_vencida','cambio_password_fallido','mfa_desactivacion_fallida','mfa_activacion_fallida','mfa_codigos_fallido')";
    return $ctx->db->prepare('SELECT a.id, a.ts, a.ip, a.accion, a.entidad, a.entidad_id, a.detalle, a.hash, u.nombre AS usuario, c.nombre AS condominio FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id LEFT JOIN condominios c ON c.id = a.condominio_id WHERE ' . implode(' AND ', $w) . ' ORDER BY a.id DESC LIMIT ? OFFSET ?')->all(...[...$a, $lim, $off]);
  }],
  ['GET', '/api/admin/estado', [], function (Ctx $ctx) {
    soloSuper($ctx);
    $now = now_ms(); $uno = fn($s) => $ctx->db->prepare($s)->get()['n'];
    $tam = fn($f) => is_file($f) ? filesize($f) : 0;
    $ab = 0; $an = 0; foreach (is_dir(files_dir()) ? scandir(files_dir()) : [] as $f) if (preg_match('/^[0-9a-f]{64}$/', $f)) { $ab += $tam(files_dir() . "/$f"); $an++; }
    return ['version' => VERSION, 'node' => 'PHP ' . PHP_VERSION, 'iniciado' => (int)(($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true)) * 1000), 'https' => $ctx->secure,
      'base_bytes' => $tam(db_path()) + $tam(db_path() . '-wal'), 'archivos' => ['n' => $an, 'bytes' => $ab],
      'respaldos' => ['n' => $uno('SELECT COUNT(*) n FROM respaldos'), 'ultimo' => $ctx->db->prepare('SELECT archivo, created_at, verificado, bytes FROM respaldos ORDER BY id DESC LIMIT 1')->get(), 'carpeta' => backup_dir()],
      'condominios' => $uno('SELECT COUNT(*) n FROM condominios WHERE activo = 1'), 'usuarios' => $uno('SELECT COUNT(*) n FROM usuarios WHERE activo = 1'),
      'sin_2fa' => $uno("SELECT COUNT(*) n FROM usuarios u WHERE u.activo = 1 AND u.totp_activo = 0 AND (u.superadmin = 1 OR EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.rol <> 'residente'))"),
      'sesiones_activas' => $ctx->db->prepare('SELECT COUNT(*) n FROM sesiones WHERE revocada = 0 AND expires_at > ? AND last_seen > ?')->get($now, $now - 1800000)['n'],
      'cuentas_bloqueadas' => $ctx->db->prepare('SELECT COUNT(*) n FROM usuarios WHERE bloqueado_hasta > ?')->get($now)['n'],
      'accesos_fallidos_24h' => $ctx->db->prepare("SELECT COUNT(*) n FROM auditoria WHERE accion = 'login_fallido' AND ts > ?")->get($now - 86400000)['n'],
      'denegados_24h' => $ctx->db->prepare("SELECT COUNT(*) n FROM auditoria WHERE accion = 'acceso_denegado' AND ts > ?")->get($now - 86400000)['n'],
      'bitacora' => $uno('SELECT COUNT(*) n FROM auditoria')];
  }],

  // ===== Buscador global =====
  ['GET', "$C/buscar", ['perm' => 'ver'], function (Ctx $ctx) {
    $t = mslice(trim((string)q($ctx, 'q', '')), 0, 60);
    if (mlen($t) < 2) return ['unidades' => [], 'personas' => [], 'pagos' => [], 'egresos' => [], 'proveedores' => []];
    $n = plano($t); $L = likeSeguro($t);
    $folio = preg_match('/^(?:[RE][- ]?)?(\d{1,9})$/i', $t, $m) ? (int)$m[1] : -1;
    $tel = preg_replace('/\D/', '', $t) ?: "\0";
    $unidades = array_slice(filt($ctx->db->prepare("SELECT u.id, u.clave, u.torre, u.referencia, (SELECT GROUP_CONCAT(p.nombre, ', ') FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id) AS personas FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave")->all($ctx->cid),
      fn($u) => str_contains(plano($u['clave']), $n) || str_contains(plano($u['referencia']), $n) || str_contains(plano($u['personas']), $n) || str_contains(plano(($u['torre'] ?? '') . ' ' . $u['clave']), $n)), 0, 6);
    $personas = array_slice(filt($ctx->db->prepare("SELECT p.id, p.nombre, p.email, p.telefono, (SELECT MIN(up.unidad_id) FROM unidad_personas up WHERE up.persona_id = p.id) AS unidad_id, (SELECT GROUP_CONCAT(u.clave, ', ') FROM unidad_personas up JOIN unidades u ON u.id = up.unidad_id WHERE up.persona_id = p.id) AS unidades FROM personas p WHERE p.condominio_id = ? AND p.activo = 1 ORDER BY p.nombre")->all($ctx->cid),
      fn($p) => str_contains(plano($p['nombre']), $n) || str_contains(plano($p['email']), $n) || str_contains(preg_replace('/\D/', '', (string)$p['telefono']), $tel)), 0, 6);
    $prov = array_slice(filt($ctx->db->prepare('SELECT id, nombre, rfc, giro FROM proveedores WHERE condominio_id = ? ORDER BY nombre')->all($ctx->cid), fn($p) => str_contains(plano($p['nombre']), $n) || str_contains(plano($p['rfc']), $n) || str_contains(plano($p['giro']), $n)), 0, 5);
    $pagos = $ctx->db->prepare("SELECT p.id, p.folio, p.fecha, p.monto_cents, p.estado, p.referencia, p.unidad_id, u.clave FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.condominio_id = ? AND p.idem_key NOT LIKE 'INI-%' AND (p.folio = ? OR p.referencia LIKE ? ESCAPE '\\') ORDER BY p.fecha DESC, p.id DESC LIMIT 6")->all($ctx->cid, $folio, $L);
    $egr = $ctx->db->prepare("SELECT e.id, e.folio, e.fecha, e.concepto, e.total_cents, e.estado, pr.nombre AS proveedor FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id WHERE e.condominio_id = ? AND (e.folio = ? OR e.concepto LIKE ? ESCAPE '\\' OR pr.nombre LIKE ? ESCAPE '\\' OR e.factura_folio LIKE ? ESCAPE '\\') ORDER BY e.fecha DESC, e.id DESC LIMIT 6")->all($ctx->cid, $folio, $L, $L, $L);
    return ['unidades' => $unidades, 'personas' => $personas, 'pagos' => $pagos, 'egresos' => $egr, 'proveedores' => $prov];
  }],

  // ===== Logotipo =====
  ['GET', "$C/logo", [], function (Ctx $ctx) {
    $a = $ctx->db->prepare('SELECT a.* FROM condominios c JOIN archivos a ON a.id = c.logo_archivo_id WHERE c.id = ? AND a.condominio_id = c.id')->get($ctx->cid) ?? fail(404, 'Sin logotipo');
    return ['__file' => ['path' => files_dir() . '/' . $a['sha256'], 'name' => $a['nombre'], 'mime' => $a['mime'], 'inline' => true]];
  }],
  ['PUT', "$C/logo", ['perm' => 'config', 'limite' => 1500000], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max160', 'base64' => 'str|max1400000']); detalle($ctx, ['nombre' => $b['nombre']]);
    return escribir($ctx, 'logo_actualizado', 'condominio', function () use ($ctx, $b) { $id = guardarArchivo($ctx, $b['nombre'], $b['base64'], true); $ctx->db->prepare('UPDATE condominios SET logo_archivo_id = ? WHERE id = ?')->run($id, $ctx->cid); return $ctx->cid; });
  }],
  ['DELETE', "$C/logo", ['perm' => 'config'], fn(Ctx $ctx) => escribir($ctx, 'logo_eliminado', 'condominio', function () use ($ctx) { $ctx->db->prepare('UPDATE condominios SET logo_archivo_id = NULL WHERE id = ?')->run($ctx->cid); return $ctx->cid; })],

  // ===== Tablero y configuración =====
  ['GET', "$C/tablero", ['perm' => 'ver'], fn(Ctx $ctx) => tablero($ctx->db, $ctx->cid, qPeriodo($ctx, 'periodo', periodoActual()))],
  ['GET', "$C/config", ['perm' => 'ver'], fn(Ctx $ctx) => condo($ctx->db, $ctx->cid)],
  ['PUT', "$C/config", ['perm' => 'config'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max120', 'razon_social' => 'str|opt|max160', 'rfc' => 'rfc|opt', 'direccion' => 'str|opt|max250', 'ciudad' => 'str|opt|max80',
      'dia_vencimiento' => 'int|min1|max28', 'dias_gracia' => 'int|min0|max60', 'tasa_recargo_bp' => 'int|min0|max2000', 'pct_reserva_bp' => 'int|min0|max5000', 'umbral_aprobacion_cents' => 'cents|zero',
      'pronto_pago_bp' => 'int|min0|max5000|opt', 'pronto_pago_dia' => 'int|min0|max28|opt', 'recargo_modo' => 'enum|saldo|cuota|fijo|opt', 'recargo_fijo_cents' => 'cents|zero|opt']);
    if ((($b['pronto_pago_bp'] ?? 0) > 0) !== (($b['pronto_pago_dia'] ?? 0) > 0) && ($b['pronto_pago_bp'] || $b['pronto_pago_dia'])) fail(400, 'Para el descuento por pronto pago indique el porcentaje y el día límite.');
    return escribir($ctx, 'config_actualizada', 'condominio', function () use ($ctx, $b) {
      $ctx->db->prepare('UPDATE condominios SET nombre=?, razon_social=?, rfc=?, direccion=?, ciudad=?, dia_vencimiento=?, dias_gracia=?, tasa_recargo_bp=?, pct_reserva_bp=?, umbral_aprobacion_cents=?, pronto_pago_bp=?, pronto_pago_dia=?, recargo_modo=COALESCE(?, recargo_modo), recargo_fijo_cents=COALESCE(?, recargo_fijo_cents) WHERE id=?')
        ->run($b['nombre'], $b['razon_social'], $b['rfc'], $b['direccion'], $b['ciudad'], $b['dia_vencimiento'], $b['dias_gracia'], $b['tasa_recargo_bp'], $b['pct_reserva_bp'], $b['umbral_aprobacion_cents'], $b['pronto_pago_bp'] ?? 0, $b['pronto_pago_dia'] ?? 0, $b['recargo_modo'], $b['recargo_fijo_cents'], $ctx->cid);
      return $ctx->cid;
    });
  }],

  // ===== Unidades y residentes =====
  ['GET', "$C/unidades", ['perm' => 'ver'], fn(Ctx $ctx) => carteraUnidades($ctx->db, $ctx->cid)],
  ['GET', "$C/unidades/:id", ['perm' => 'ver'], function (Ctx $ctx) {
    $u = unidadDelCondo($ctx, idParam($ctx));
    return ['unidad' => $u, 'personas' => $ctx->db->prepare('SELECT up.id AS vinculo_id, up.rol, p.* FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? ORDER BY up.rol')->all($u['id']),
      'cartera' => find(carteraUnidades($ctx->db, $ctx->cid), fn($x) => $x['id'] === $u['id']),
      'pagos' => $ctx->db->prepare('SELECT * FROM pagos WHERE unidad_id = ? ORDER BY fecha DESC, id DESC LIMIT 24')->all($u['id']),
      'gestiones' => $ctx->db->prepare('SELECT g.*, us.nombre AS autor FROM gestiones g LEFT JOIN usuarios us ON us.id = g.created_by WHERE g.unidad_id = ? ORDER BY g.created_at DESC LIMIT 30')->all($u['id']),
      'convenio' => $ctx->db->prepare("SELECT * FROM convenios WHERE unidad_id = ? AND estado = 'vigente'")->get($u['id'])];
  }],
  ['POST', "$C/unidades", ['perm' => 'config'], function (Ctx $ctx) {
    $b = v($ctx->body, ['clave' => 'str|max20', 'torre' => 'str|opt|max30', 'tipo' => 'enum|departamento|casa|local|oficina|bodega|estacionamiento', 'm2' => 'int|opt|min0|max100000',
      'indiviso_ppm' => 'int|min0|max1000000', 'cuota_cents' => 'cents|zero', 'estado' => 'enum|ocupada|vacante|renta', 'notas' => 'str|opt|max300']);
    return escribir($ctx, 'unidad_creada', 'unidad', function () use ($ctx, $b) {
      if ($ctx->db->prepare('SELECT 1 FROM unidades WHERE condominio_id = ? AND clave = ?')->get($ctx->cid, $b['clave'])) fail(409, 'Ya existe una unidad con esa clave.', 'DUPLICADO');
      return $ctx->db->prepare('INSERT INTO unidades (condominio_id, clave, torre, tipo, m2, indiviso_ppm, cuota_cents, referencia, estado, notas, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        ->run($ctx->cid, $b['clave'], $b['torre'], $b['tipo'], $b['m2'], $b['indiviso_ppm'], $b['cuota_cents'], referenciaPago($ctx->db, $ctx->cid, $b['clave']), $b['estado'], $b['notas'], now_ms())['lastInsertRowid'];
    });
  }],
  ['PUT', "$C/unidades/:id", ['perm' => 'config'], function (Ctx $ctx) {
    $u = unidadDelCondo($ctx, idParam($ctx));
    $b = v($ctx->body, ['torre' => 'str|opt|max30', 'tipo' => 'enum|departamento|casa|local|oficina|bodega|estacionamiento', 'm2' => 'int|opt|min0|max100000', 'indiviso_ppm' => 'int|min0|max1000000', 'cuota_cents' => 'cents|zero', 'estado' => 'enum|ocupada|vacante|renta', 'notas' => 'str|opt|max300', 'activo' => 'bool']);
    detalle($ctx, ['antes' => ['cuota_cents' => $u['cuota_cents'], 'indiviso_ppm' => $u['indiviso_ppm'], 'activo' => $u['activo']], 'despues' => $b]);
    return escribir($ctx, 'unidad_actualizada', 'unidad', function () use ($ctx, $b, $u) { $ctx->db->prepare('UPDATE unidades SET torre=?, tipo=?, m2=?, indiviso_ppm=?, cuota_cents=?, estado=?, notas=?, activo=? WHERE id=?')->run($b['torre'], $b['tipo'], $b['m2'], $b['indiviso_ppm'], $b['cuota_cents'], $b['estado'], $b['notas'], $b['activo'] ? 1 : 0, $u['id']); return $u['id']; });
  }],
  ['GET', "$C/personas", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare("SELECT p.*, (SELECT GROUP_CONCAT(u.clave || ':' || up.rol, ', ') FROM unidad_personas up JOIN unidades u ON u.id = up.unidad_id WHERE up.persona_id = p.id) AS unidades FROM personas p WHERE p.condominio_id = ? AND p.activo = 1 ORDER BY p.nombre")->all($ctx->cid)],
  ['POST', "$C/personas", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max120', 'email' => 'email|opt', 'telefono' => 'str|opt|max30', 'rfc' => 'rfc|opt', 'notas' => 'str|opt|max300', 'unidad_id' => 'int|opt', 'rol' => 'enum|propietario|inquilino|responsable|opt']);
    return escribir($ctx, 'persona_creada', 'persona', function () use ($ctx, $b) {
      if ($b['email'] && $ctx->db->prepare('SELECT 1 FROM personas WHERE condominio_id = ? AND email = ? COLLATE NOCASE AND activo = 1')->get($ctx->cid, $b['email'])) fail(409, 'Ya existe una persona con ese correo.', 'DUPLICADO');
      $id = $ctx->db->prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, rfc, notas, created_at) VALUES (?,?,?,?,?,?,?)')->run($ctx->cid, $b['nombre'], $b['email'], $b['telefono'], $b['rfc'], $b['notas'], now_ms())['lastInsertRowid'];
      if ($b['unidad_id']) { unidadDelCondo($ctx, $b['unidad_id']); $ctx->db->prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)')->run($b['unidad_id'], $id, $b['rol'] ?: 'propietario'); }
      return $id;
    });
  }],
  ['PUT', "$C/personas/:id", ['perm' => 'capturar'], function (Ctx $ctx) {
    $id = idParam($ctx);
    $ctx->db->prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?')->get($id, $ctx->cid) ?? fail(404, 'Persona no encontrada');
    $b = v($ctx->body, ['nombre' => 'str|max120', 'email' => 'email|opt', 'telefono' => 'str|opt|max30', 'rfc' => 'rfc|opt', 'notas' => 'str|opt|max300']);
    return escribir($ctx, 'persona_actualizada', 'persona', function () use ($ctx, $b, $id) { $ctx->db->prepare('UPDATE personas SET nombre=?, email=?, telefono=?, rfc=?, notas=? WHERE id=?')->run($b['nombre'], $b['email'], $b['telefono'], $b['rfc'], $b['notas'], $id); return $id; });
  }],
  ['POST', "$C/unidades/:id/personas", ['perm' => 'capturar'], function (Ctx $ctx) {
    $u = unidadDelCondo($ctx, idParam($ctx));
    $b = v($ctx->body, ['persona_id' => 'int|min1', 'rol' => 'enum|propietario|inquilino|responsable']);
    $ctx->db->prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?')->get($b['persona_id'], $ctx->cid) ?? fail(404, 'Persona no encontrada');
    return escribir($ctx, 'persona_vinculada', 'unidad', function () use ($ctx, $u, $b) {
      if ($ctx->db->prepare('SELECT 1 FROM unidad_personas WHERE unidad_id = ? AND persona_id = ? AND rol = ?')->get($u['id'], $b['persona_id'], $b['rol'])) fail(409, 'La persona ya está vinculada con ese rol.');
      $ctx->db->prepare('INSERT INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)')->run($u['id'], $b['persona_id'], $b['rol']); return $u['id'];
    });
  }],
  ['DELETE', "$C/unidades/:id/personas/:vid", ['perm' => 'capturar'], function (Ctx $ctx) {
    $u = unidadDelCondo($ctx, idParam($ctx));
    return escribir($ctx, 'persona_desvinculada', 'unidad', function () use ($ctx, $u) { $ctx->db->prepare('DELETE FROM unidad_personas WHERE id = ? AND unidad_id = ?')->run(idParam($ctx, 'vid'), $u['id']); return $u['id']; });
  }],

  // ===== Estados de cuenta y cobranza =====
  ['GET', "$C/estado-cuenta/:id", [], function (Ctx $ctx) {
    $uid = idParam($ctx); resi($ctx, $uid);
    $u = unidadDelCondo($ctx, $uid);
    $hasta = qFecha($ctx, 'hasta', hoy()); $desde = qFecha($ctx, 'desde', addMonths(periodoDe($hasta), -5) . '-01');
    $pers = $ctx->db->prepare('SELECT p.nombre, p.email, up.rol FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ?')->all($u['id']);
    return ['condominio' => datosCondo(condo($ctx->db, $ctx->cid)), 'unidad' => $u, 'personas' => $pers, 'bancos' => bancosOperacion($ctx), 'desde' => $desde, 'hasta' => $hasta] + estadoCuenta($ctx->db, $ctx->cid, $u['id'], $desde, $hasta);
  }],
  ['GET', "$C/estados-cuenta", ['perm' => 'ver'], function (Ctx $ctx) {
    $hasta = qFecha($ctx, 'hasta', hoy()); $desde = qFecha($ctx, 'desde', periodoDe($hasta) . '-01');
    return ['condominio' => datosCondo(condo($ctx->db, $ctx->cid)), 'bancos' => bancosOperacion($ctx), 'desde' => $desde, 'hasta' => $hasta,
      'unidades' => array_map(fn($u) => ['unidad' => $u, 'propietario' => $ctx->db->prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'")->get($u['id'])['n']] + estadoCuenta($ctx->db, $ctx->cid, $u['id'], $desde, $hasta),
        $ctx->db->prepare('SELECT id, clave, torre, referencia, cuota_cents FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY torre, clave')->all($ctx->cid))];
  }],
  ['GET', "$C/cargos", ['perm' => 'ver'], function (Ctx $ctx) {
    $w = ['c.condominio_id = ?']; $a = [$ctx->cid];
    if (q($ctx, 'unidad')) { $w[] = 'c.unidad_id = ?'; $a[] = qInt($ctx, 'unidad'); }
    if (q($ctx, 'periodo')) { $w[] = 'c.periodo = ?'; $a[] = qPeriodo($ctx, 'periodo'); }
    if (q($ctx, 'tipo')) { $w[] = 'c.tipo = ?'; $a[] = q($ctx, 'tipo'); }
    return $ctx->db->prepare('SELECT c.*, u.clave, c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0) AS saldo_cents FROM cargos c JOIN unidades u ON u.id = c.unidad_id WHERE ' . implode(' AND ', $w) . ' ORDER BY c.fecha DESC, u.clave LIMIT 2000')->all(...$a);
  }],
  ['GET', "$C/emisiones", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare("SELECT p.id, p.fecha, p.periodo, p.concepto, p.origen, p.total_cents, p.tipo, p.folio, COUNT(c.id) AS cargos, us.nombre AS autor FROM polizas p JOIN cargos c ON c.poliza_id = p.id LEFT JOIN usuarios us ON us.id = p.created_by WHERE p.condominio_id = ? AND p.origen IN ('emision','extraordinaria','recargos') GROUP BY p.id ORDER BY p.fecha DESC, p.id DESC LIMIT 60")->all($ctx->cid)],
  ['POST', "$C/cobranza/emitir", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['periodo' => 'periodo']); return escribir($ctx, 'cuotas_emitidas', 'emision', fn() => emitirCuotas($ctx->db, $ctx->cid, $b['periodo'], $ctx->user)); }],
  ['POST', "$C/cobranza/extraordinaria", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['concepto' => 'str|max120', 'total_cents' => 'cents', 'metodo' => 'enum|indiviso|igual', 'destino' => 'enum|operacion|reserva|fondo', 'fondo_id' => 'int|opt', 'fecha' => 'date', 'vencimiento' => 'date', 'unidades' => 'arr|opt']);
    if ($b['destino'] === 'fondo' && !$b['fondo_id']) fail(400, 'Seleccione el fondo que recibirá la cuota.');
    return escribir($ctx, 'extraordinaria_emitida', 'emision', fn() => emitirExtraordinaria($ctx->db, $ctx->cid, $b, $ctx->user));
  }],
  ['POST', "$C/cobranza/cargo", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['unidad_id' => 'int|min1', 'tipo' => 'enum|extraordinaria|multa|otro', 'concepto' => 'str|max120', 'monto_cents' => 'cents', 'fecha' => 'date', 'vencimiento' => 'date|opt']); return escribir($ctx, 'cargo_individual', 'cargo', fn() => cargoIndividual($ctx->db, $ctx->cid, $b, $ctx->user)); }],
  ['POST', "$C/cobranza/recargos", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['periodo' => 'periodo']); return escribir($ctx, 'recargos_calculados', 'emision', fn() => calcularRecargos($ctx->db, $ctx->cid, $b['periodo'], $ctx->user)); }],
  ['POST', "$C/cobranza/recargo-manual", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['cargo_id' => 'int|min1', 'modo' => 'enum|porcentaje|monto', 'porcentaje_bp' => 'int|min1|max5000|opt', 'monto_cents' => 'cents|opt', 'fecha' => 'date', 'concepto' => 'str|opt|max120']);
    if ($b['modo'] === 'porcentaje' && !$b['porcentaje_bp']) fail(400, 'Indique el porcentaje del recargo.');
    if ($b['modo'] === 'monto' && !$b['monto_cents']) fail(400, 'Indique el monto del recargo.');
    return escribir($ctx, 'recargo_manual', 'cargo', fn() => recargoManual($ctx->db, $ctx->cid, $b, $ctx->user));
  }],
  ['POST', "$C/cargos/:id/bonificar", ['perm' => 'cancelar'], function (Ctx $ctx) { $b = v($ctx->body, ['monto_cents' => 'cents', 'motivo' => 'str|max200']); return escribir($ctx, 'cargo_bonificado', 'cargo', fn() => ['id' => idParam($ctx), 'poliza' => bonificar($ctx->db, $ctx->cid, idParam($ctx), $b['monto_cents'], $b['motivo'], $ctx->user)]); }],
  ['POST', "$C/cargos/:id/cancelar", ['perm' => 'cancelar'], function (Ctx $ctx) { $b = v($ctx->body, ['motivo' => 'str|max200']); return escribir($ctx, 'cargo_cancelado', 'cargo', fn() => ['id' => idParam($ctx), 'poliza' => cancelarCargo($ctx->db, $ctx->cid, idParam($ctx), $b['motivo'], $ctx->user)]); }],

  // ===== Pagos =====
  ['GET', "$C/pagos", ['perm' => 'ver'], function (Ctx $ctx) {
    $w = ['p.condominio_id = ?']; $a = [$ctx->cid];
    if (q($ctx, 'estado')) { $w[] = 'p.estado = ?'; $a[] = q($ctx, 'estado'); }
    if (q($ctx, 'unidad')) { $w[] = 'p.unidad_id = ?'; $a[] = qInt($ctx, 'unidad'); }
    if (q($ctx, 'desde')) { $w[] = 'p.fecha >= ?'; $a[] = qFecha($ctx, 'desde'); }
    if (q($ctx, 'hasta')) { $w[] = 'p.fecha <= ?'; $a[] = qFecha($ctx, 'hasta'); }
    return $ctx->db->prepare("SELECT p.*, u.clave, b.banco, b.nombre AS cuenta_nombre, a.nombre AS comprobante_nombre, us.nombre AS capturo, (SELECT COUNT(*) FROM banco_movs bm WHERE bm.conciliado_tipo = 'pago' AND bm.conciliado_id = p.id) AS conciliado
      FROM pagos p JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id LEFT JOIN archivos a ON a.id = p.comprobante_id LEFT JOIN usuarios us ON us.id = p.created_by WHERE " . implode(' AND ', $w) . ' ORDER BY p.fecha DESC, p.id DESC LIMIT 1000')->all(...$a);
  }],
  ['POST', "$C/pagos", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, PAGO_BODY); return escribir($ctx, 'pago_registrado', 'pago', fn() => registrarPago($ctx->db, $ctx->cid, $b, $ctx->user)); }],
  ['POST', "$C/pagos/:id/validar", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['aceptar' => 'bool', 'motivo' => 'str|opt|max200', 'cuenta_banco_id' => 'int|opt']); return escribir($ctx, $b['aceptar'] ? 'pago_validado' : 'pago_rechazado', 'pago', fn() => ['id' => idParam($ctx)] + validarPago($ctx->db, $ctx->cid, idParam($ctx), $b, $ctx->user)); }],
  ['POST', "$C/pagos/:id/cancelar", ['perm' => 'cancelar'], function (Ctx $ctx) { $b = v($ctx->body, ['motivo' => 'str|max200']); return escribir($ctx, 'pago_cancelado', 'pago', fn() => ['id' => idParam($ctx)] + (array)cancelarPago($ctx->db, $ctx->cid, idParam($ctx), $b['motivo'], $ctx->user)); }],
  ['GET', "$C/pagos/:id/recibo", [], function (Ctx $ctx) {
    $p = $ctx->db->prepare('SELECT p.*, u.clave, u.referencia AS ref_unidad, b.banco FROM pagos p JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id WHERE p.id = ? AND p.condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Pago no encontrado');
    if ($ctx->rol === 'residente') { if (!some(unidadesDeResidente($ctx), fn($u) => $u['id'] === $p['unidad_id'])) fail(404, 'Pago no encontrado'); } else exigir($ctx, 'ver');
    if ($p['estado'] !== 'aplicado' && $p['estado'] !== 'cancelado') fail(409, 'El pago aún no tiene recibo.');
    return reciboDe($ctx, $p);
  }],
  ['GET', "$C/recibos", [], function (Ctx $ctx) {
    $uid = qInt($ctx, 'unidad') ?? fail(400, 'Indique la unidad.'); resi($ctx, $uid);
    $hasta = qFecha($ctx, 'hasta', hoy()); $desde = qFecha($ctx, 'desde', substr(hoy(), 0, 4) . '-01-01');
    return array_map(fn($p) => reciboDe($ctx, $p), $ctx->db->prepare("SELECT p.*, u.clave, u.referencia AS ref_unidad, b.banco FROM pagos p JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id WHERE p.unidad_id = ? AND p.condominio_id = ? AND p.folio IS NOT NULL AND p.estado IN ('aplicado','cancelado') AND p.fecha BETWEEN ? AND ? ORDER BY p.fecha, p.folio")->all($uid, $ctx->cid, $desde, $hasta));
  }],

  // ===== Morosidad =====
  ['GET', "$C/morosidad", ['perm' => 'ver'], function (Ctx $ctx) {
    $corte = qFecha($ctx, 'corte', hoy());
    if ($corte > hoy()) fail(400, 'La fecha de corte no puede ser futura.');
    $rows = carteraUnidades($ctx->db, $ctx->cid, $corte);
    return ['corte' => $corte, 'resumen' => resumenCartera($rows), 'unidades' => $rows] + (q($ctx, 'detalle') === '1' ? ['cargos' => carteraDetalle($ctx->db, $ctx->cid, $corte), 'tendencia' => tendenciaMorosidad($ctx->db, $ctx->cid, periodoDe($corte))] : []);
  }],
  ['POST', "$C/gestiones", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['unidad_id' => 'int|min1', 'tipo' => 'enum|llamada|correo|whatsapp|visita|carta|promesa|aviso_legal', 'nota' => 'str|max500', 'promesa_fecha' => 'date|opt', 'promesa_cents' => 'cents|opt']);
    unidadDelCondo($ctx, $b['unidad_id']);
    return escribir($ctx, 'gestion_cobranza', 'unidad', fn() => $ctx->db->prepare('INSERT INTO gestiones (condominio_id, unidad_id, tipo, nota, promesa_fecha, promesa_cents, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')->run($ctx->cid, $b['unidad_id'], $b['tipo'], $b['nota'], $b['promesa_fecha'], $b['promesa_cents'], $ctx->user['id'], now_ms())['lastInsertRowid']);
  }],
  ['GET', "$C/constancia/:id", ['perm' => 'ver'], function (Ctx $ctx) {
    $u = unidadDelCondo($ctx, idParam($ctx));
    $cart = find(carteraUnidades($ctx->db, $ctx->cid), fn($x) => $x['id'] === $u['id']);
    $prop = $ctx->db->prepare("SELECT GROUP_CONCAT(p.nombre, ', ') n FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = 'propietario'")->get($u['id'])['n'];
    $folio = "CA-{$ctx->cid}-{$u['id']}-" . strtoupper(base_convert((string)now_ms(), 10, 36));
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $ctx->cid, 'ip' => $ctx->ip, 'accion' => 'constancia_emitida', 'entidad' => 'unidad', 'entidad_id' => $u['id'], 'detalle' => ['folio' => $folio, 'adeudo' => $cart['adeudo']]]);
    return ['tipo' => $cart['adeudo'] > 0 ? 'adeudo' : 'no_adeudo', 'folio' => $folio, 'fecha' => hoy(), 'condominio' => condo($ctx->db, $ctx->cid), 'unidad' => $u, 'propietario' => $prop, 'adeudo' => $cart['adeudo'], 'vencido' => $cart['vencido'], 'saldo_favor' => $cart['saldo_favor'],
      'detalle' => cargosAbiertos($ctx->db, $u['id']), 'sello' => strtoupper(substr(sha256("{$folio}|{$u['id']}|{$cart['adeudo']}|" . hoy()), 0, 24))];
  }],
  ['GET', "$C/convenios", ['perm' => 'ver'], fn(Ctx $ctx) => array_map(function ($cv) use ($ctx) {
    $est = $cv['estado'] === 'vigente' ? estadoConvenio($ctx->db, $cv) : null;
    if ($est && $est['restante'] <= 0) { $ctx->db->prepare("UPDATE convenios SET estado = 'cumplido' WHERE id = ?")->run($cv['id']); $cv['estado'] = 'cumplido'; }
    return array_merge($cv, $est ?? [], ['parcialidades_det' => $ctx->db->prepare('SELECT * FROM convenio_parcialidades WHERE convenio_id = ? ORDER BY numero')->all($cv['id'])]);
  }, $ctx->db->prepare('SELECT cv.*, u.clave FROM convenios cv JOIN unidades u ON u.id = cv.unidad_id WHERE cv.condominio_id = ? ORDER BY cv.created_at DESC')->all($ctx->cid))],
  ['POST', "$C/convenios", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['unidad_id' => 'int|min1', 'parcialidades' => 'int|min1|max60', 'fecha' => 'date', 'condonar_recargos' => 'bool', 'notas' => 'str|opt|max300']);
    if ($b['condonar_recargos']) exigir($ctx, 'cancelar');
    return escribir($ctx, 'convenio_creado', 'convenio', fn() => crearConvenio($ctx->db, $ctx->cid, $b, $ctx->user));
  }],
  ['POST', "$C/convenios/:id/cancelar", ['perm' => 'cancelar'], fn(Ctx $ctx) => escribir($ctx, 'convenio_cancelado', 'convenio', function () use ($ctx) {
    if (!$ctx->db->prepare("UPDATE convenios SET estado = 'cancelado' WHERE id = ? AND condominio_id = ? AND estado = 'vigente'")->run(idParam($ctx), $ctx->cid)['changes']) fail(404, 'Convenio vigente no encontrado'); return idParam($ctx);
  })],

  // ===== Egresos y proveedores =====
  ['GET', "$C/proveedores", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare("SELECT pr.*, (SELECT COALESCE(SUM(total_cents), 0) FROM egresos e WHERE e.proveedor_id = pr.id AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 4) = ?) AS ejercido_anio FROM proveedores pr WHERE pr.condominio_id = ? ORDER BY pr.nombre")->all(substr(hoy(), 0, 4), $ctx->cid)],
  ['POST', "$C/proveedores", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max160', 'rfc' => 'rfc|opt', 'giro' => 'str|opt|max80', 'email' => 'email|opt', 'telefono' => 'str|opt|max30', 'clabe' => 'str|opt|max18']);
    if ($b['clabe'] && !preg_match('/^\d{18}$/', $b['clabe'])) fail(400, 'La CLABE debe tener 18 dígitos.');
    return escribir($ctx, 'proveedor_creado', 'proveedor', function () use ($ctx, $b) {
      if ($b['rfc'] && $ctx->db->prepare('SELECT 1 FROM proveedores WHERE condominio_id = ? AND rfc = ?')->get($ctx->cid, $b['rfc'])) fail(409, 'Ya existe un proveedor con ese RFC.', 'DUPLICADO');
      return $ctx->db->prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, email, telefono, clabe_mask, created_at) VALUES (?,?,?,?,?,?,?,?)')->run($ctx->cid, $b['nombre'], $b['rfc'], $b['giro'], $b['email'], $b['telefono'], mask($b['clabe']), now_ms())['lastInsertRowid'];
    });
  }],
  ['PUT', "$C/proveedores/:id", ['perm' => 'capturar'], function (Ctx $ctx) {
    $id = idParam($ctx);
    $ctx->db->prepare('SELECT 1 FROM proveedores WHERE id = ? AND condominio_id = ?')->get($id, $ctx->cid) ?? fail(404, 'Proveedor no encontrado');
    $b = v($ctx->body, ['nombre' => 'str|max160', 'giro' => 'str|opt|max80', 'email' => 'email|opt', 'telefono' => 'str|opt|max30', 'activo' => 'bool']);
    return escribir($ctx, 'proveedor_actualizado', 'proveedor', function () use ($ctx, $b, $id) { $ctx->db->prepare('UPDATE proveedores SET nombre=?, giro=?, email=?, telefono=?, activo=? WHERE id=?')->run($b['nombre'], $b['giro'], $b['email'], $b['telefono'], $b['activo'] ? 1 : 0, $id); return $id; });
  }],
  ['GET', "$C/egresos", ['perm' => 'ver'], function (Ctx $ctx) {
    $w = ['e.condominio_id = ?']; $a = [$ctx->cid];
    if (q($ctx, 'estado')) { $w[] = 'e.estado = ?'; $a[] = q($ctx, 'estado'); }
    if (q($ctx, 'desde')) { $w[] = 'e.fecha >= ?'; $a[] = qFecha($ctx, 'desde'); }
    if (q($ctx, 'hasta')) { $w[] = 'e.fecha <= ?'; $a[] = qFecha($ctx, 'hasta'); }
    return $ctx->db->prepare("SELECT e.*, pr.nombre AS proveedor, k.codigo AS partida_codigo, k.nombre AS partida, uc.nombre AS capturo, ua.nombre AS aprobo, a.nombre AS comprobante_nombre, (SELECT nombre FROM fondos f WHERE f.id = e.fondo_id) AS fondo_nombre,
      (SELECT COUNT(*) FROM banco_movs bm WHERE bm.conciliado_tipo = 'egreso' AND bm.conciliado_id = e.id) AS conciliado
      FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN usuarios uc ON uc.id = e.created_by LEFT JOIN usuarios ua ON ua.id = e.aprobado_por LEFT JOIN archivos a ON a.id = e.comprobante_id
      WHERE " . implode(' AND ', $w) . ' ORDER BY e.fecha DESC, e.id DESC LIMIT 1000')->all(...$a);
  }],
  ['POST', "$C/egresos", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['proveedor_id' => 'int|opt', 'cuenta_id' => 'int|min1', 'fondo' => 'enum|operacion|reserva', 'fondo_id' => 'int|opt', 'fecha' => 'date', 'concepto' => 'str|max200', 'subtotal_cents' => 'cents|zero', 'iva_cents' => 'cents|zero',
      'retenciones_cents' => 'cents|zero', 'factura_folio' => 'str|opt|max40', 'cfdi_uuid' => 'uuid|opt', 'comprobante_id' => 'int|opt', 'idem_key' => 'key']);
    return escribir($ctx, 'egreso_capturado', 'egreso', fn() => crearEgreso($ctx->db, $ctx->cid, $b, $ctx->user));
  }],
  ['POST', "$C/egresos/:id/aprobar", ['perm' => 'aprobar'], function (Ctx $ctx) { $b = v($ctx->body, ['aprobar' => 'bool', 'motivo' => 'str|opt|max200']); return escribir($ctx, $b['aprobar'] ? 'egreso_aprobado' : 'egreso_rechazado', 'egreso', fn() => ['id' => idParam($ctx)] + aprobarEgreso($ctx->db, $ctx->cid, idParam($ctx), $b['aprobar'], $b['motivo'], $ctx->user)); }],
  ['POST', "$C/egresos/:id/pagar", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['fecha_pago' => 'date', 'metodo' => 'enum|transferencia|cheque|efectivo|tarjeta|domiciliacion', 'cuenta_banco_id' => 'int|opt', 'referencia' => 'str|opt|max60']); return escribir($ctx, 'egreso_pagado', 'egreso', fn() => ['id' => idParam($ctx)] + pagarEgreso($ctx->db, $ctx->cid, idParam($ctx), $b, $ctx->user)); }],
  ['POST', "$C/egresos/:id/cancelar", ['perm' => 'cancelar'], function (Ctx $ctx) { $b = v($ctx->body, ['motivo' => 'str|max200']); return escribir($ctx, 'egreso_cancelado', 'egreso', function () use ($ctx, $b) { cancelarEgreso($ctx->db, $ctx->cid, idParam($ctx), $b['motivo'], $ctx->user); return ['id' => idParam($ctx)]; }); }],
  ['POST', "$C/cfdi/leer", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['base64' => 'str|max7000000']);
    $xml = (string)base64_decode($b['base64']);
    if (strlen($xml) > 2000000 || preg_match('/<!DOCTYPE|<!ENTITY/i', $xml)) fail(400, 'XML no permitido.');
    $d = leerCfdi($xml);
    $prov = $d['emisor_rfc'] ? $ctx->db->prepare('SELECT id, nombre FROM proveedores WHERE condominio_id = ? AND rfc = ?')->get($ctx->cid, strtoupper($d['emisor_rfc'])) : null;
    $dup = $ctx->db->prepare("SELECT folio FROM egresos WHERE condominio_id = ? AND cfdi_uuid = ? COLLATE NOCASE AND estado NOT IN ('cancelado','rechazado')")->get($ctx->cid, $d['uuid']);
    return $d + ['proveedor' => $prov, 'duplicado' => $dup ? "E-{$dup['folio']}" : null];
  }],

  // ===== Archivos =====
  ['POST', "$C/archivos", ['limite' => 8000000], function (Ctx $ctx) {
    if (!in_array($ctx->rol, PERMS['capturar'], true) && $ctx->rol !== 'residente') fail(403, 'No tiene permiso para subir archivos.');
    $b = v($ctx->body, ['nombre' => 'str|max160', 'base64' => 'str|max7000000']);
    return tx($ctx->db, fn() => ['id' => guardarArchivo($ctx, $b['nombre'], $b['base64'])]);
  }],
  ['GET', "$C/archivos/:id", [], function (Ctx $ctx) {
    $a = $ctx->db->prepare('SELECT * FROM archivos WHERE id = ? AND condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Archivo no encontrado');
    if ($ctx->rol === 'residente') {
      $mios = col(unidadesDeResidente($ctx), 'id');
      $lig = some($ctx->db->prepare('SELECT unidad_id FROM pagos WHERE comprobante_id = ? AND condominio_id = ?')->all($a['id'], $ctx->cid), fn($p) => in_array($p['unidad_id'], $mios, true));
      if (!$lig && $a['created_by'] !== $ctx->user['id']) fail(404, 'Archivo no encontrado');
    } else exigir($ctx, 'ver');
    return ['__file' => ['path' => files_dir() . '/' . $a['sha256'], 'name' => $a['nombre'], 'mime' => $a['mime']]];
  }],

  // ===== Bancos y conciliación =====
  ['GET', "$C/bancos", ['perm' => 'ver'], fn(Ctx $ctx) => array_map(fn($b) => $b + [
      'saldo_estado' => $ctx->db->prepare('SELECT COALESCE(SUM(abono_cents - cargo_cents), 0) s FROM banco_movs WHERE cuenta_banco_id = ?')->get($b['id'])['s'],
      'sin_conciliar' => $ctx->db->prepare('SELECT COUNT(*) n FROM banco_movs WHERE cuenta_banco_id = ? AND conciliado_tipo IS NULL')->get($b['id'])['n'],
      'ultimo_mov' => $ctx->db->prepare('SELECT MAX(fecha) f FROM banco_movs WHERE cuenta_banco_id = ?')->get($b['id'])['f']], saldoBancos($ctx->db, $ctx->cid)['bancos'])],
  ['POST', "$C/bancos", ['perm' => 'config'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max60', 'banco' => 'str|max40', 'numero' => 'str|max20', 'clabe' => 'str|opt|max18', 'fondo' => 'enum|operacion|reserva']);
    if ($b['clabe'] && !preg_match('/^\d{18}$/', $b['clabe'])) fail(400, 'La CLABE debe tener 18 dígitos.');
    detalle($ctx, ['nombre' => $b['nombre'], 'banco' => $b['banco'], 'numero' => mask($b['numero']), 'fondo' => $b['fondo']]);
    return escribir($ctx, 'cuenta_bancaria_creada', 'banco', fn() => crearCuentaBanco($ctx->db, $ctx->cid, $b));
  }],
  ['GET', "$C/bancos/:id/movimientos", ['perm' => 'ver'], function (Ctx $ctx) {
    $bid = idParam($ctx);
    $ctx->db->prepare('SELECT 1 FROM cuentas_banco WHERE id = ? AND condominio_id = ?')->get($bid, $ctx->cid) ?? fail(404, 'Cuenta no encontrada');
    $movs = $ctx->db->prepare('SELECT * FROM banco_movs WHERE cuenta_banco_id = ? ' . (q($ctx, 'estado') === 'pendientes' ? 'AND conciliado_tipo IS NULL' : '') . ' ORDER BY fecha DESC, id DESC LIMIT 500')->all($bid);
    $refs = $ctx->db->prepare('SELECT id, clave, referencia FROM unidades WHERE condominio_id = ?')->all($ctx->cid);
    return array_map(function ($m) use ($ctx, $refs) {
      $texto = mb_strtoupper(($m['descripcion'] ?? '') . ' ' . ($m['referencia'] ?? ''));
      $sug = !$m['conciliado_tipo'] && $m['abono_cents'] ? find($refs, fn($u) => str_contains($texto, $u['referencia'])) : null;
      $det = null;
      if ($m['conciliado_tipo'] === 'pago') $det = $ctx->db->prepare("SELECT 'R-' || p.folio || ' · ' || u.clave AS t FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.id = ?")->get($m['conciliado_id'])['t'] ?? null;
      if ($m['conciliado_tipo'] === 'egreso') $det = $ctx->db->prepare("SELECT 'E-' || folio || ' · ' || concepto AS t FROM egresos WHERE id = ?")->get($m['conciliado_id'])['t'] ?? null;
      return $m + ['sugerida' => $sug, 'detalle' => $det];
    }, $movs);
  }],
  ['POST', "$C/bancos/:id/importar", ['perm' => 'capturar', 'limite' => 4000000], function (Ctx $ctx) {
    $b = v($ctx->body, ['filas' => 'arr']);
    $filas = [];
    foreach ($b['filas'] as $i => $f) {
      try { $x = v($f, ['fecha' => 'date', 'descripcion' => 'str|opt|max200', 'referencia' => 'str|opt|max60', 'cargo_cents' => 'cents|zero', 'abono_cents' => 'cents|zero']); }
      catch (AppError $e) { fail(400, 'Fila ' . ($i + 1) . ': ' . $e->getMessage()); }
      if (($x['cargo_cents'] > 0) !== ($x['abono_cents'] > 0)) $filas[] = $x;
    }
    if (!$filas) fail(400, 'El archivo no contiene movimientos válidos.');
    detalle($ctx, ['filas' => count($filas)]);
    return escribir($ctx, 'estado_bancario_importado', 'banco', fn() => ['id' => idParam($ctx)] + importarMovimientosBanco($ctx->db, $ctx->cid, idParam($ctx), $filas, $ctx->user));
  }],
  ['POST', "$C/bancos/:id/autoconciliar", ['perm' => 'capturar'], function (Ctx $ctx) {
    $ctx->db->prepare('SELECT 1 FROM cuentas_banco WHERE id = ? AND condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Cuenta no encontrada');
    return escribir($ctx, 'autoconciliacion', 'banco', fn() => ['id' => idParam($ctx), 'conciliados' => autoConciliar($ctx->db, $ctx->cid, idParam($ctx), $ctx->user)]);
  }],
  ['GET', "$C/banco-movs/:id/candidatos", ['perm' => 'ver'], function (Ctx $ctx) {
    $m = $ctx->db->prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE bm.id = ? AND b.condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Movimiento no encontrado');
    if ($m['abono_cents']) return $ctx->db->prepare("SELECT p.id, 'pago' AS tipo, p.fecha, p.monto_cents AS monto, 'R-' || p.folio || ' · ' || u.clave || COALESCE(' · ' || p.referencia, '') AS descripcion FROM pagos p JOIN unidades u ON u.id = p.unidad_id
      WHERE p.condominio_id = ? AND p.estado = 'aplicado' AND p.idem_key NOT LIKE 'INI-%' AND p.monto_cents = ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'pago' AND x.conciliado_id = p.id) ORDER BY ABS(julianday(p.fecha) - julianday(?)) LIMIT 10")->all($ctx->cid, $m['abono_cents'], $m['fecha']);
    return $ctx->db->prepare("SELECT e.id, 'egreso' AS tipo, e.fecha_pago AS fecha, e.total_cents AS monto, 'E-' || e.folio || ' · ' || e.concepto AS descripcion FROM egresos e
      WHERE e.condominio_id = ? AND e.estado = 'pagado' AND e.total_cents = ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'egreso' AND x.conciliado_id = e.id) ORDER BY ABS(julianday(e.fecha_pago) - julianday(?)) LIMIT 10")->all($ctx->cid, $m['cargo_cents'], $m['fecha']);
  }],
  ['POST', "$C/banco-movs/:id/conciliar", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['tipo' => 'enum|pago|egreso|otro|ninguno', 'id' => 'int|opt']);
    return escribir($ctx, $b['tipo'] === 'ninguno' ? 'desconciliacion' : 'conciliacion_manual', 'banco_mov', function () use ($ctx, $b) { conciliarManual($ctx->db, $ctx->cid, idParam($ctx), $b['tipo'] === 'ninguno' ? null : $b['tipo'], $b['id'], $ctx->user); return idParam($ctx); });
  }],
  ['POST', "$C/banco-movs/:id/crear-pago", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['unidad_id' => 'int|min1']);
    $m = $ctx->db->prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco cb ON cb.id = bm.cuenta_banco_id WHERE bm.id = ? AND cb.condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Movimiento no encontrado');
    if (!$m['abono_cents'] || $m['conciliado_tipo']) fail(409, 'El movimiento no es un depósito pendiente.');
    return escribir($ctx, 'pago_desde_banco', 'pago', function () use ($ctx, $b, $m) {
      $r = registrarPago($ctx->db, $ctx->cid, ['unidad_id' => $b['unidad_id'], 'fecha' => $m['fecha'], 'monto_cents' => $m['abono_cents'], 'metodo' => 'transferencia', 'referencia' => mslice((string)($m['referencia'] ?: $m['descripcion'] ?: ''), 0, 60) ?: null,
        'cuenta_banco_id' => $m['cuenta_banco_id'], 'idem_key' => 'BANCO-' . substr($m['huella'], 0, 40), 'confirmar_duplicado' => true, 'notas' => 'Identificado desde estado de cuenta bancario'], $ctx->user);
      conciliarManual($ctx->db, $ctx->cid, $m['id'], 'pago', $r['id'], $ctx->user);
      return $r;
    });
  }],

  // ===== Presupuesto =====
  ['GET', "$C/presupuestos", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT p.*, u.nombre AS aprobo, (SELECT COALESCE(SUM(monto_cents), 0) FROM presupuesto_lineas l WHERE l.presupuesto_id = p.id) AS total FROM presupuestos p LEFT JOIN usuarios u ON u.id = p.aprobado_por WHERE p.condominio_id = ? ORDER BY ejercicio DESC, version DESC')->all($ctx->cid)],
  ['POST', "$C/presupuestos", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['ejercicio' => 'int|min2000|max2100']); return escribir($ctx, 'presupuesto_borrador', 'presupuesto', fn() => nuevaVersionPresupuesto($ctx->db, $ctx->cid, $b['ejercicio'], $ctx->user)); }],
  ['GET', "$C/presupuestos/:id", ['perm' => 'ver'], function (Ctx $ctx) {
    $p = $ctx->db->prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Presupuesto no encontrado');
    return ['presupuesto' => $p, 'cuentas' => $ctx->db->prepare("SELECT id, codigo, nombre, tipo_gasto FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo")->all($ctx->cid),
      'lineas' => $ctx->db->prepare('SELECT * FROM presupuesto_lineas WHERE presupuesto_id = ?')->all($p['id']), 'vs' => presupuestoVsReal($ctx->db, $ctx->cid, $p['ejercicio'], $p['id']), 'sugerida' => cuotaSugerida($ctx->db, $ctx->cid, $p['id'])];
  }],
  ['PUT', "$C/presupuestos/:id/lineas", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['lineas' => 'arr']); detalle($ctx, ['lineas' => count($b['lineas'])]); return escribir($ctx, 'presupuesto_editado', 'presupuesto', function () use ($ctx, $b) { guardarLineasPresupuesto($ctx->db, $ctx->cid, idParam($ctx), $b['lineas']); return idParam($ctx); }); }],
  ['POST', "$C/presupuestos/:id/aprobar", ['perm' => 'config'], function (Ctx $ctx) { $b = v($ctx->body, ['acta' => 'str|max200']); return escribir($ctx, 'presupuesto_aprobado', 'presupuesto', function () use ($ctx, $b) { aprobarPresupuesto($ctx->db, $ctx->cid, idParam($ctx), $b['acta'], $ctx->user); return idParam($ctx); }); }],
  ['POST', "$C/presupuestos/:id/aplicar-cuotas", ['perm' => 'config'], function (Ctx $ctx) {
    $p = $ctx->db->prepare("SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ? AND estado = 'aprobado'")->get(idParam($ctx), $ctx->cid) ?? fail(409, 'Solo se aplican cuotas de un presupuesto aprobado.');
    $s = cuotaSugerida($ctx->db, $ctx->cid, $p['id']);
    detalle($ctx, ['presupuesto' => $p['id'], 'cambios' => array_map(fn($u) => [$u['clave'], $u['cuota_cents'], $u['sugerida_cents']], filt($s['unidades'], fn($u) => $u['cuota_cents'] !== $u['sugerida_cents']))]);
    return escribir($ctx, 'cuotas_actualizadas', 'presupuesto', function () use ($ctx, $s, $p) { foreach ($s['unidades'] as $u) $ctx->db->prepare('UPDATE unidades SET cuota_cents = ? WHERE id = ? AND condominio_id = ?')->run($u['sugerida_cents'], $u['id'], $ctx->cid); return ['id' => $p['id'], 'unidades' => count($s['unidades'])]; });
  }],

  // ===== Fondos, adeudos recurrentes, descuentos =====
  ['GET', "$C/fondos", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT f.*, k.codigo FROM fondos f JOIN cuentas k ON k.id = f.cuenta_id WHERE f.condominio_id = ? ORDER BY f.nombre')->all($ctx->cid)],
  ['POST', "$C/fondos", ['perm' => 'config'], function (Ctx $ctx) { $b = v($ctx->body, ['nombre' => 'str|max80', 'meta_cents' => 'cents|opt', 'descripcion' => 'str|opt|max300']); return escribir($ctx, 'fondo_creado', 'fondo', fn() => crearFondo($ctx->db, $ctx->cid, $b, $ctx->user)); }],
  ['PUT', "$C/fondos/:id", ['perm' => 'config'], function (Ctx $ctx) {
    $id = idParam($ctx);
    $ctx->db->prepare('SELECT 1 FROM fondos WHERE id = ? AND condominio_id = ?')->get($id, $ctx->cid) ?? fail(404, 'Fondo no encontrado');
    $b = v($ctx->body, ['meta_cents' => 'cents|opt', 'descripcion' => 'str|opt|max300', 'activo' => 'bool']);
    return escribir($ctx, 'fondo_actualizado', 'fondo', function () use ($ctx, $b, $id) { $ctx->db->prepare('UPDATE fondos SET meta_cents = ?, descripcion = ?, activo = ? WHERE id = ?')->run($b['meta_cents'], $b['descripcion'], $b['activo'] ? 1 : 0, $id); return $id; });
  }],
  ['GET', "$C/cargos-recurrentes", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT r.*, u.clave, us.nombre AS autor FROM cargos_recurrentes r LEFT JOIN unidades u ON u.id = r.unidad_id LEFT JOIN usuarios us ON us.id = r.created_by WHERE r.condominio_id = ? ORDER BY r.activo DESC, r.created_at DESC')->all($ctx->cid)],
  ['POST', "$C/cargos-recurrentes", ['perm' => 'capturar'], function (Ctx $ctx) { $b = v($ctx->body, ['unidad_id' => 'int|opt', 'tipo' => 'enum|extraordinaria|otro|multa', 'concepto' => 'str|max100', 'monto_cents' => 'cents', 'desde' => 'periodo', 'hasta' => 'periodo|opt']); return escribir($ctx, 'cargo_recurrente_creado', 'cargo_recurrente', fn() => crearCargoRecurrente($ctx->db, $ctx->cid, $b, $ctx->user)); }],
  ['POST', "$C/cargos-recurrentes/:id/desactivar", ['perm' => 'capturar'], fn(Ctx $ctx) => escribir($ctx, 'cargo_recurrente_desactivado', 'cargo_recurrente', function () use ($ctx) {
    if (!$ctx->db->prepare('UPDATE cargos_recurrentes SET activo = 0 WHERE id = ? AND condominio_id = ? AND activo = 1')->run(idParam($ctx), $ctx->cid)['changes']) fail(404, 'Cargo recurrente activo no encontrado'); return idParam($ctx);
  })],
  ['GET', "$C/descuentos", ['perm' => 'ver'], fn(Ctx $ctx) => descuentos($ctx->db, $ctx->cid, qFecha($ctx, 'desde', substr(hoy(), 0, 4) . '-01-01'), qFecha($ctx, 'hasta', hoy()))],
  ['POST', "$C/descuentos/lote", ['perm' => 'cancelar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['periodo' => 'periodo', 'pct_bp' => 'int|min1|max10000', 'motivo' => 'str|max160', 'unidades' => 'arr|opt']);
    return escribir($ctx, 'descuento_lote', 'cargo', function () use ($ctx, $b) {
      $f = $b['unidades'] ? array_map('intval', $b['unidades']) : null;
      $cs = filt($ctx->db->prepare("SELECT c.id, c.unidad_id, c.monto_cents FROM cargos c WHERE c.condominio_id = ? AND c.periodo = ? AND c.tipo = 'ordinaria' AND c.cancelado_at IS NULL")->all($ctx->cid, $b['periodo']), fn($c) => !$f || in_array($c['unidad_id'], $f, true));
      $n = 0; $total = 0;
      foreach ($cs as $c) {
        $saldo = find(cargosAbiertos($ctx->db, $c['unidad_id']), fn($x) => $x['id'] === $c['id'])['saldo_cents'] ?? 0;
        $m = min($saldo, jround($c['monto_cents'] * $b['pct_bp'] / 10000));
        if ($m > 0) { bonificar($ctx->db, $ctx->cid, $c['id'], $m, $b['motivo'], $ctx->user); $n++; $total += $m; }
      }
      if (!$n) fail(400, 'No hay cuotas ordinarias con saldo pendiente en ese periodo.');
      return ['id' => null, 'cargos' => $n, 'total' => $total];
    });
  }],

  // ===== Importación =====
  ['GET', "$C/importar/catalogos", ['perm' => 'ver'], fn(Ctx $ctx) => catalogosPlantilla($ctx->db, $ctx->cid)],
  ['POST', "$C/importar/:tipo", ['limite' => 8000000], function (Ctx $ctx) {
    if (!limiteUsuario($ctx, 'importar', 300)) fail(429, 'Demasiadas importaciones en poco tiempo; espere unos minutos.');
    return importar($ctx, $ctx->params['tipo'], $ctx->body, PERMS, fn($p) => in_array($ctx->rol, PERMS[$p], true));
  }],

  // ===== Contabilidad =====
  ['GET', "$C/cuentas", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT * FROM cuentas WHERE condominio_id = ? ORDER BY codigo')->all($ctx->cid)],
  ['POST', "$C/cuentas", ['perm' => 'config'], function (Ctx $ctx) {
    $b = v($ctx->body, ['codigo' => 'str|max12', 'nombre' => 'str|max120', 'tipo' => 'enum|activo|pasivo|patrimonio|ingreso|egreso', 'tipo_gasto' => 'enum|fijo|variable|opt']);
    if (!preg_match('/^\d{4}(-\d{2})?$/', $b['codigo'])) fail(400, 'Código con formato 0000 o 0000-00.');
    $nat = in_array($b['tipo'], ['activo', 'egreso'], true) ? 'D' : 'A';
    return escribir($ctx, 'cuenta_creada', 'cuenta', function () use ($ctx, $b, $nat) {
      if ($ctx->db->prepare('SELECT 1 FROM cuentas WHERE condominio_id = ? AND codigo = ?')->get($ctx->cid, $b['codigo'])) fail(409, 'Ya existe una cuenta con ese código.', 'DUPLICADO');
      return $ctx->db->prepare('INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, presupuestable, tipo_gasto) VALUES (?,?,?,?,?,?,?)')->run($ctx->cid, $b['codigo'], $b['nombre'], $b['tipo'], $nat, $b['tipo'] === 'egreso' ? 1 : 0, $b['tipo'] === 'egreso' ? ($b['tipo_gasto'] ?: 'variable') : null)['lastInsertRowid'];
    });
  }],
  ['PUT', "$C/cuentas/:id", ['perm' => 'config'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|opt|max120', 'tipo_gasto' => 'enum|fijo|variable|opt']);
    $k = $ctx->db->prepare('SELECT * FROM cuentas WHERE id = ? AND condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Cuenta no encontrada');
    if ($b['tipo_gasto'] && $k['tipo'] !== 'egreso') fail(400, 'Solo los rubros de egreso son fijos o variables.');
    detalle($ctx, ['codigo' => $k['codigo']] + $b);
    return escribir($ctx, 'cuenta_actualizada', 'cuenta', function () use ($ctx, $b, $k) { $ctx->db->prepare('UPDATE cuentas SET nombre = COALESCE(?, nombre), tipo_gasto = COALESCE(?, tipo_gasto) WHERE id = ?')->run($b['nombre'], $b['tipo_gasto'], $k['id']); return $k['id']; });
  }],
  ['GET', "$C/polizas", ['perm' => 'ver'], function (Ctx $ctx) {
    $w = ['p.condominio_id = ?']; $a = [$ctx->cid];
    if (q($ctx, 'periodo')) { $w[] = 'p.periodo = ?'; $a[] = qPeriodo($ctx, 'periodo'); }
    if (q($ctx, 'tipo')) { $w[] = 'p.tipo = ?'; $a[] = q($ctx, 'tipo'); }
    if (q($ctx, 'q')) { $w[] = 'p.concepto LIKE ?'; $a[] = '%' . str_replace(['%', '_'], '', mslice(q($ctx, 'q'), 0, 60)) . '%'; }
    return $ctx->db->prepare('SELECT p.*, u.nombre AS autor FROM polizas p LEFT JOIN usuarios u ON u.id = p.created_by WHERE ' . implode(' AND ', $w) . ' ORDER BY p.fecha DESC, p.id DESC LIMIT 500')->all(...$a);
  }],
  ['GET', "$C/polizas/:id", ['perm' => 'ver'], function (Ctx $ctx) {
    $p = $ctx->db->prepare('SELECT p.*, u.nombre AS autor FROM polizas p LEFT JOIN usuarios u ON u.id = p.created_by WHERE p.id = ? AND p.condominio_id = ?')->get(idParam($ctx), $ctx->cid) ?? fail(404, 'Póliza no encontrada');
    return ['poliza' => $p, 'movimientos' => $ctx->db->prepare('SELECT m.*, k.codigo, k.nombre AS cuenta, un.clave AS unidad FROM movimientos m JOIN cuentas k ON k.id = m.cuenta_id LEFT JOIN unidades un ON un.id = m.unidad_id WHERE m.poliza_id = ? ORDER BY m.id')->all($p['id'])];
  }],
  ['POST', "$C/polizas", ['perm' => 'capturar'], function (Ctx $ctx) {
    $b = v($ctx->body, ['tipo' => 'enum|I|E|D', 'fecha' => 'date', 'concepto' => 'str|max200', 'lineas' => 'arr']);
    $b['lineas'] = array_map(fn($l) => v($l, ['cuenta' => 'int|min1', 'debe' => 'cents|zero', 'haber' => 'cents|zero', 'concepto' => 'str|opt|max120']), $b['lineas']);
    return escribir($ctx, 'poliza_manual', 'poliza', fn() => polizaManual($ctx->db, $ctx->cid, $b, $ctx->user));
  }],
  ['POST', "$C/polizas/:id/revertir", ['perm' => 'cancelar'], function (Ctx $ctx) { $b = v($ctx->body, ['motivo' => 'str|max200']); return escribir($ctx, 'poliza_revertida', 'poliza', fn() => revertirPoliza($ctx->db, $ctx->cid, idParam($ctx), $b['motivo'], $ctx->user)); }],

  // ===== Reportes =====
  ['GET', "$C/reportes/resultados", ['perm' => 'ver'], fn(Ctx $ctx) => estadoResultados($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', substr(hoy(), 0, 4) . '-01'), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/balance", ['perm' => 'ver'], fn(Ctx $ctx) => balanceGeneral($ctx->db, $ctx->cid, qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/balanza", ['perm' => 'ver'], fn(Ctx $ctx) => balanza($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', periodoActual()), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/mayor", ['perm' => 'ver'], fn(Ctx $ctx) => libroMayor($ctx->db, $ctx->cid, qInt($ctx, 'cuenta') ?? fail(400, 'Indique la cuenta'), qPeriodo($ctx, 'desde', substr(hoy(), 0, 4) . '-01'), qPeriodo($ctx, 'hasta', periodoActual())) ?? fail(404, 'Cuenta no encontrada')],
  ['GET', "$C/reportes/presupuesto", ['perm' => 'ver'], fn(Ctx $ctx) => presupuestoVsReal($ctx->db, $ctx->cid, qInt($ctx, 'ejercicio', (int)substr(hoy(), 0, 4)))],
  ['GET', "$C/reportes/flujo", ['perm' => 'ver'], fn(Ctx $ctx) => flujoEfectivo($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', substr(hoy(), 0, 4) . '-01'), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/fondo-reserva", ['perm' => 'ver'], fn(Ctx $ctx) => fondoReserva($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', substr(hoy(), 0, 4) . '-01'), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/cobranza", ['perm' => 'ver'], fn(Ctx $ctx) => cobranzaMensual($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', addMonths(periodoActual(), -11)), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/fondos", ['perm' => 'ver'], fn(Ctx $ctx) => fondos($ctx->db, $ctx->cid, qPeriodo($ctx, 'desde', substr(hoy(), 0, 4) . '-01'), qPeriodo($ctx, 'hasta', periodoActual()))],
  ['GET', "$C/reportes/cxp", ['perm' => 'ver'], fn(Ctx $ctx) => cuentasPorPagar($ctx->db, $ctx->cid, qFecha($ctx, 'corte', hoy()))],
  ['GET', "$C/reportes/liquidacion-egresos", ['perm' => 'ver'], fn(Ctx $ctx) => liquidacionEgresos($ctx->db, $ctx->cid, qInt($ctx, 'ejercicio', (int)substr(hoy(), 0, 4)))],
  ['GET', "$C/reportes/liquidacion", ['perm' => 'ver'], fn(Ctx $ctx) => liquidacionAnual($ctx->db, $ctx->cid, qInt($ctx, 'ejercicio', (int)substr(hoy(), 0, 4)))],
  ['GET', "$C/reportes/anual", ['perm' => 'ver'], fn(Ctx $ctx) => informeAnual($ctx->db, $ctx->cid, qInt($ctx, 'ejercicio', (int)substr(hoy(), 0, 4)))],
  ['GET', "$C/reportes/ingresos", ['perm' => 'ver'], function (Ctx $ctx) { $r = qRango($ctx); return ['anio' => $r['anio'], 'mes' => $r['mes']] + ingresos($ctx->db, $ctx->cid, $r['desde'], $r['hasta']) + ['mensual' => ingresosMensual($ctx->db, $ctx->cid, $r['anio'])['meses']]; }],
  ['GET', "$C/reportes/egresos", ['perm' => 'ver'], function (Ctx $ctx) { $r = qRango($ctx); return ['anio' => $r['anio'], 'mes' => $r['mes']] + egresosReporte($ctx->db, $ctx->cid, $r['desde'], $r['hasta']) + ['mensual' => egresosMensual($ctx->db, $ctx->cid, $r['anio'])['meses']]; }],
  ['GET', "$C/reportes/bancos", ['perm' => 'ver'], function (Ctx $ctx) { $r = qRango($ctx); return ['anio' => $r['anio'], 'mes' => $r['mes']] + saldosBancarios($ctx->db, $ctx->cid, $r['desdeP'], $r['hastaP']); }],
  ['GET', "$C/reportes/conciliacion", ['perm' => 'ver'], function (Ctx $ctx) { $r = qRango($ctx); return ['anio' => $r['anio'], 'mes' => $r['mes']] + conciliacion($ctx->db, $ctx->cid, $r['desdeP'], $r['hastaP']); }],
  ['GET', "$C/integridad", ['perm' => 'ver'], fn(Ctx $ctx) => verificarIntegridad($ctx->db, $ctx->cid)],

  // ===== Exportaciones CSV =====
  ['GET', "$C/export/:tipo", ['perm' => 'ver'], function (Ctx $ctx) {
    $t = $ctx->params['tipo']; $P = fn($k) => fn($r) => pesosCsv($r[$k]); $K = fn($k) => fn($r) => $r[$k];
    if ($t === 'cartera.csv') $body = csvSeguro(carteraUnidades($ctx->db, $ctx->cid), [['Unidad', $K('clave')], ['Torre', $K('torre')], ['Propietario', $K('propietario')], ['Referencia', $K('referencia')], ['Cuota', $P('cuota_cents')],
      ['Por vencer', $P('por_vencer')], ['1-30', $P('d30')], ['31-60', $P('d60')], ['61-90', $P('d90')], ['90+', $P('d90mas')], ['Vencido', $P('vencido')], ['Saldo a favor', $P('saldo_favor')], ['Último pago', $K('ultimo_pago')]]);
    elseif ($t === 'pagos.csv') $body = csvSeguro($ctx->db->prepare('SELECT p.*, u.clave FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.condominio_id = ? ORDER BY p.fecha')->all($ctx->cid),
      [['Recibo', fn($r) => $r['folio'] ? "R-{$r['folio']}" : ''], ['Fecha', $K('fecha')], ['Unidad', $K('clave')], ['Importe', $P('monto_cents')], ['Método', $K('metodo')], ['Referencia', $K('referencia')], ['Estado', $K('estado')]]);
    elseif ($t === 'egresos.csv') $body = csvSeguro($ctx->db->prepare('SELECT e.*, k.nombre AS partida, pr.nombre AS proveedor FROM egresos e JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN proveedores pr ON pr.id = e.proveedor_id WHERE e.condominio_id = ? ORDER BY e.fecha')->all($ctx->cid),
      [['Folio', fn($r) => "E-{$r['folio']}"], ['Fecha', $K('fecha')], ['Proveedor', $K('proveedor')], ['Partida', $K('partida')], ['Fondo', $K('fondo')], ['Concepto', $K('concepto')], ['Subtotal', $P('subtotal_cents')], ['IVA', $P('iva_cents')], ['Total', $P('total_cents')], ['UUID', $K('cfdi_uuid')], ['Estado', $K('estado')]]);
    elseif ($t === 'polizas.csv') $body = csvSeguro($ctx->db->prepare('SELECT p.tipo, p.folio, p.fecha, p.concepto AS pc, k.codigo, k.nombre, m.debe_cents, m.haber_cents, m.concepto, u.clave FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id LEFT JOIN unidades u ON u.id = m.unidad_id WHERE p.condominio_id = ? ORDER BY p.fecha, p.id, m.id')->all($ctx->cid),
      [['Póliza', fn($r) => "{$r['tipo']}-{$r['folio']}"], ['Fecha', $K('fecha')], ['Concepto póliza', $K('pc')], ['Cuenta', $K('codigo')], ['Nombre', $K('nombre')], ['Unidad', $K('clave')], ['Debe', $P('debe_cents')], ['Haber', $P('haber_cents')], ['Concepto', $K('concepto')]]);
    else fail(404, 'Exportación no disponible');
    audit($ctx->db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $ctx->cid, 'ip' => $ctx->ip, 'accion' => 'exportacion', 'detalle' => ['tipo' => $t]]);
    return ['__raw' => ['body' => $body, 'mime' => 'text/csv; charset=utf-8', 'name' => $t]];
  }],

  // ===== Periodos y cierres =====
  ['GET', "$C/periodos", ['perm' => 'ver'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT pe.*, u.nombre AS cerro, (SELECT COUNT(*) FROM polizas p WHERE p.condominio_id = pe.condominio_id AND p.periodo = pe.periodo) AS polizas FROM periodos pe LEFT JOIN usuarios u ON u.id = pe.cerrado_por WHERE pe.condominio_id = ? ORDER BY pe.periodo DESC')->all($ctx->cid)],
  ['GET', "$C/periodos/:p/checklist", ['perm' => 'ver'], function (Ctx $ctx) { $p = $ctx->params['p']; if (!preg_match('/^\d{4}-\d{2}$/', $p)) fail(400, 'Periodo inválido'); return checklistCierre($ctx->db, $ctx->cid, $p); }],
  ['POST', "$C/periodos/:p/cerrar", ['perm' => 'cerrar'], function (Ctx $ctx) {
    $p = $ctx->params['p']; if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $p)) fail(400, 'Periodo inválido');
    validarCierre($ctx->db, $ctx->cid, $p);
    try { crearRespaldo($ctx->db, "antes de cerrar {$p}"); } catch (Throwable $e) { error_log('[respaldo] ' . $e->getMessage()); fail(500, 'No se pudo crear el respaldo previo al cierre; el cierre se canceló por seguridad.'); }
    return escribir($ctx, 'periodo_cerrado', 'periodo', fn() => cerrarPeriodo($ctx->db, $ctx->cid, $p, $ctx->user));
  }],
  ['POST', "$C/periodos/:p/reabrir", [], function (Ctx $ctx) {
    if (!$ctx->user['superadmin']) fail(403, 'Solo el superadministrador puede reabrir un periodo.');
    $p = $ctx->params['p']; if (!preg_match('/^\d{4}-\d{2}$/', $p)) fail(400, 'Periodo inválido');
    v($ctx->body, ['motivo' => 'str|max200']);
    return escribir($ctx, 'periodo_reabierto', 'periodo', function () use ($ctx, $p) { reabrirPeriodo($ctx->db, $ctx->cid, $p); return null; });
  }],
  ['POST', "$C/ejercicios/:anio/cerrar", ['perm' => 'cerrar'], function (Ctx $ctx) {
    $anio = idParam($ctx, 'anio');
    if ($anio < 2000 || $anio >= (int)substr(hoy(), 0, 4)) fail(409, 'Solo se cierra un ejercicio ya terminado.');
    try { crearRespaldo($ctx->db, "antes de cerrar ejercicio {$anio}"); } catch (Throwable $e) { error_log('[respaldo] ' . $e->getMessage()); fail(500, 'No se pudo crear el respaldo previo; el cierre se canceló por seguridad.'); }
    return escribir($ctx, 'ejercicio_cerrado', 'ejercicio', fn() => cerrarEjercicio($ctx->db, $ctx->cid, $anio, $ctx->user));
  }],
  ['POST', "$C/ejercicios/:anio/reabrir", [], function (Ctx $ctx) {
    if (!$ctx->user['superadmin']) fail(403, 'Solo el superadministrador puede reabrir un ejercicio.');
    $b = v($ctx->body, ['motivo' => 'str|max200']);
    return escribir($ctx, 'ejercicio_reabierto', 'ejercicio', fn() => reabrirEjercicio($ctx->db, $ctx->cid, idParam($ctx, 'anio'), $b['motivo'], $ctx->user));
  }],

  // ===== Auditoría y usuarios =====
  ['GET', "$C/auditoria", ['perm' => 'auditoria'], function (Ctx $ctx) {
    $lim = min(qInt($ctx, 'limit', 100), 500); $off = qInt($ctx, 'offset', 0);
    return $ctx->db->prepare('SELECT a.id, a.ts, a.ip, a.accion, a.entidad, a.entidad_id, a.detalle, a.hash, u.nombre AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id WHERE a.condominio_id = ? ORDER BY a.id DESC LIMIT ? OFFSET ?')->all($ctx->cid, $lim, $off);
  }],
  ['GET', "$C/usuarios", ['perm' => 'usuarios'], fn(Ctx $ctx) => $ctx->db->prepare('SELECT u.id, u.nombre, u.email, u.activo, u.totp_activo, u.ultimo_acceso, u.bloqueado_hasta, m.rol, m.persona_id, p.nombre AS persona FROM membresias m JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN personas p ON p.id = m.persona_id WHERE m.condominio_id = ? ORDER BY m.rol, u.nombre')->all($ctx->cid)],
  ['POST', "$C/usuarios", ['perm' => 'usuarios'], function (Ctx $ctx) {
    $b = v($ctx->body, ['nombre' => 'str|max120', 'email' => 'email', 'rol' => 'enum|admin|contador|comite|residente', 'persona_id' => 'int|opt']);
    if ($b['rol'] === 'residente' && !$b['persona_id']) fail(400, 'Vincule al residente con su registro en el padrón.');
    if ($b['persona_id']) $ctx->db->prepare('SELECT 1 FROM personas WHERE id = ? AND condominio_id = ?')->get($b['persona_id'], $ctx->cid) ?? fail(404, 'Persona no encontrada');
    $t = tempPass();
    $r = escribir($ctx, 'usuario_invitado', 'usuario', function () use ($ctx, $b, $t) {
      $u = $ctx->db->prepare('SELECT id FROM usuarios WHERE email = ?')->get($b['email']); $nuevo = false;
      if (!$u) { $u = ['id' => $ctx->db->prepare('INSERT INTO usuarios (email, nombre, pass_hash, debe_cambiar_pass, pass_temporal_hasta, created_at) VALUES (?,?,?,1,?,?)')->run($b['email'], $b['nombre'], hashPassword($t), now_ms() + TEMPORAL_MS, now_ms())['lastInsertRowid']]; $nuevo = true; }
      if ($ctx->db->prepare('SELECT 1 FROM membresias WHERE usuario_id = ? AND condominio_id = ?')->get($u['id'], $ctx->cid)) fail(409, 'El usuario ya tiene acceso a este condominio.');
      $ctx->db->prepare('INSERT INTO membresias (usuario_id, condominio_id, rol, persona_id) VALUES (?,?,?,?)')->run($u['id'], $ctx->cid, $b['rol'], $b['persona_id']);
      return ['id' => $u['id'], 'nuevo' => $nuevo];
    });
    return $r + ['password_temporal' => $r['nuevo'] ? $t : null];
  }],
  ['POST', "$C/usuarios/:id/restablecer", ['perm' => 'usuarios'], function (Ctx $ctx) {
    $u = usuarioAdministrable($ctx, idParam($ctx)); $t = tempPass(); detalle($ctx, ['usuario' => $u['email']]);
    escribir($ctx, 'password_restablecida', 'usuario', function () use ($ctx, $u, $t) { $ctx->db->prepare('UPDATE usuarios SET pass_hash = ?, debe_cambiar_pass = 1, pass_temporal_hasta = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?')->run(hashPassword($t), now_ms() + TEMPORAL_MS, $u['id']); revocarSesionesDe($ctx->db, $u['id']); return $u['id']; });
    return ['id' => $u['id'], 'password_temporal' => $t];
  }],
  ['POST', "$C/usuarios/:id/restablecer-2fa", ['perm' => 'usuarios'], function (Ctx $ctx) {
    $u = usuarioAdministrable($ctx, idParam($ctx)); detalle($ctx, ['usuario' => $u['email']]);
    return escribir($ctx, 'mfa_restablecido', 'usuario', function () use ($ctx, $u) { $ctx->db->prepare('UPDATE usuarios SET totp_activo = 0, totp_secret = NULL, totp_ultimo_paso = NULL WHERE id = ?')->run($u['id']); $ctx->db->prepare('DELETE FROM totp_respaldo WHERE usuario_id = ?')->run($u['id']); revocarSesionesDe($ctx->db, $u['id']); return $u['id']; });
  }],
  ['POST', "$C/usuarios/:id/desbloquear", ['perm' => 'usuarios'], function (Ctx $ctx) {
    $u = usuarioAdministrable($ctx, idParam($ctx)); detalle($ctx, ['usuario' => $u['email']]);
    return escribir($ctx, 'cuenta_desbloqueada', 'usuario', function () use ($ctx, $u) { $ctx->db->prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?')->run($u['id']); return $u['id']; });
  }],
  ['PUT', "$C/usuarios/:id", ['perm' => 'usuarios'], function (Ctx $ctx) {
    $uid = idParam($ctx); $b = v($ctx->body, ['rol' => 'enum|admin|contador|comite|residente', 'activo' => 'bool']);
    if ($uid === $ctx->user['id']) fail(400, 'No puede modificar su propio acceso.');
    return escribir($ctx, $b['activo'] ? 'usuario_actualizado' : 'acceso_revocado', 'usuario', function () use ($ctx, $uid, $b) {
      if (!$b['activo']) { $ctx->db->prepare('DELETE FROM membresias WHERE usuario_id = ? AND condominio_id = ?')->run($uid, $ctx->cid); if (!$ctx->db->prepare('SELECT 1 FROM membresias WHERE usuario_id = ?')->get($uid)) $ctx->db->prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ?')->run($uid); }
      elseif (!$ctx->db->prepare('UPDATE membresias SET rol = ? WHERE usuario_id = ? AND condominio_id = ?')->run($b['rol'], $uid, $ctx->cid)['changes']) fail(404, 'Usuario no encontrado');
      return $uid;
    });
  }],

  // ===== Portal del residente =====
  ['GET', "$C/mi", ['perm' => 'residente'], function (Ctx $ctx) {
    $anio = substr(hoy(), 0, 4);
    $er = estadoResultados($ctx->db, $ctx->cid, "{$anio}-01", periodoActual());
    $part = array_map(fn($e) => ['nombre' => $e['nombre'], 'total' => $e['total']], $er['egresos']); usort($part, fn($a, $b) => $b['total'] <=> $a['total']);
    return ['bancos' => $ctx->db->prepare("SELECT id, banco, nombre, clabe_mask FROM cuentas_banco WHERE condominio_id = ? AND activo = 1 AND fondo = 'operacion'")->all($ctx->cid),
      'unidades' => array_map(fn($u) => ['unidad' => $u] + estadoCuenta($ctx->db, $ctx->cid, $u['id'], addMonths(periodoActual(), -11) . '-01', hoy()) + ['pagos' => $ctx->db->prepare('SELECT id, folio, fecha, monto_cents, metodo, referencia, estado, motivo FROM pagos WHERE unidad_id = ? ORDER BY fecha DESC, id DESC LIMIT 24')->all($u['id'])], unidadesDeResidente($ctx)),
      'transparencia' => ['ejercicio' => $anio, 'ingresos' => $er['totales']['ingresos'], 'egresos' => $er['totales']['egresos'], 'partidas' => $part, 'fondo_reserva' => saldoCuentaClave($ctx->db, $ctx->cid, 'FONDO_RESERVA'), 'cobranza' => cobranzaMensual($ctx->db, $ctx->cid, "{$anio}-01", periodoActual())]];
  }],
]; }
