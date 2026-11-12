<?php
// Motor financiero: partida doble, cobranza, egresos, conciliación, presupuesto y cierres (equivale a server/finanzas.mjs).
declare(strict_types=1);

const CATALOGO = [
  ['1101', 'Caja', 'activo', 'D', 'CAJA', 0],
  ['1201', 'Cuotas por cobrar a condóminos', 'activo', 'D', 'CXC', 0],
  ['2101', 'Proveedores por pagar', 'pasivo', 'A', 'CXP', 0],
  ['2102', 'Anticipos y saldos a favor de condóminos', 'pasivo', 'A', 'ANTICIPOS', 0],
  ['3101', 'Fondo de reserva', 'patrimonio', 'A', 'FONDO_RESERVA', 0],
  ['3201', 'Remanente de ejercicios anteriores', 'patrimonio', 'A', 'REMANENTE', 0],
  ['4101', 'Cuotas ordinarias de mantenimiento', 'ingreso', 'A', 'ING_ORD', 0],
  ['4102', 'Cuotas extraordinarias', 'ingreso', 'A', 'ING_EXT', 0],
  ['4103', 'Recargos por mora', 'ingreso', 'A', 'ING_REC', 0],
  ['4104', 'Multas y sanciones', 'ingreso', 'A', 'ING_MULTA', 0],
  ['4105', 'Otros ingresos', 'ingreso', 'A', 'ING_OTRO', 0],
  ['4190', 'Bonificaciones y condonaciones', 'ingreso', 'D', 'BONIF', 0],
  ['5101', 'Energía eléctrica', 'egreso', 'D', null, 1],
  ['5102', 'Agua potable', 'egreso', 'D', null, 1],
  ['5103', 'Gas', 'egreso', 'D', null, 1],
  ['5201', 'Seguridad y vigilancia', 'egreso', 'D', null, 1],
  ['5202', 'Limpieza', 'egreso', 'D', null, 1],
  ['5203', 'Jardinería', 'egreso', 'D', null, 1],
  ['5301', 'Mantenimiento de elevadores', 'egreso', 'D', null, 1],
  ['5302', 'Mantenimiento general y reparaciones', 'egreso', 'D', null, 1],
  ['5303', 'Equipos hidráulicos y bombas', 'egreso', 'D', null, 1],
  ['5401', 'Honorarios de administración', 'egreso', 'D', null, 1],
  ['5402', 'Honorarios contables y legales', 'egreso', 'D', null, 1],
  ['5403', 'Nómina y seguridad social', 'egreso', 'D', null, 1],
  ['5501', 'Seguros del inmueble', 'egreso', 'D', null, 1],
  ['5502', 'Comisiones bancarias', 'egreso', 'D', null, 1],
  ['5503', 'Papelería y gastos de oficina', 'egreso', 'D', null, 1],
  ['5590', 'Otros gastos', 'egreso', 'D', null, 1],
];
const CUENTA_CARGO = ['ordinaria' => 'ING_ORD', 'extraordinaria' => 'ING_EXT', 'recargo' => 'ING_REC', 'multa' => 'ING_MULTA', 'otro' => 'ING_OTRO'];
const SALDO_CARGO = 'c.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0), 0)';
const MOTIVO_PRONTO_PAGO = 'Descuento por pronto pago';
function uid_($user): ?int { return is_array($user) ? ($user['id'] ?? null) : null; }
function pctTxt(int $bp): string { return preg_replace('/\.00$/', '', number_format($bp / 100, 2, '.', '')); }

function crearCondominio(DB $db, array $d, $user): int {
  $r = $db->prepare('INSERT INTO condominios (nombre, razon_social, rfc, direccion, ciudad, dia_vencimiento, dias_gracia, tasa_recargo_bp, pct_reserva_bp, umbral_aprobacion_cents, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    ->run($d['nombre'], $d['razon_social'] ?? null, $d['rfc'] ?? null, $d['direccion'] ?? null, $d['ciudad'] ?? null, $d['dia_vencimiento'] ?? 10, $d['dias_gracia'] ?? 0, $d['tasa_recargo_bp'] ?? 300, $d['pct_reserva_bp'] ?? 1000, $d['umbral_aprobacion_cents'] ?? 1000000, now_ms());
  $cid = $r['lastInsertRowid'];
  foreach (CATALOGO as [$codigo, $nombre, $tipo, $nat, $clave, $pres]) $db->prepare('INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, clave, presupuestable) VALUES (?,?,?,?,?,?,?)')->run($cid, $codigo, $nombre, $tipo, $nat, $clave, $pres);
  tipoGastoPorDefecto($db);
  return $cid;
}
function cuenta(DB $db, int $cid, string $clave): int {
  $r = $db->prepare('SELECT id FROM cuentas WHERE condominio_id = ? AND clave = ?')->get($cid, $clave);
  if (!$r) fail(500, "Cuenta de sistema {$clave} inexistente");
  return $r['id'];
}
function condo(DB $db, int $cid): array { return $db->prepare('SELECT * FROM condominios WHERE id = ?')->get($cid) ?? fail(404, 'Condominio no encontrado'); }
function unidadDe(DB $db, int $cid, $uid): array { $u = $db->prepare('SELECT * FROM unidades WHERE id = ? AND condominio_id = ?')->get($uid, $cid); if (!$u) fail(404, 'Unidad no encontrada'); return $u; }
function periodoAbierto(DB $db, int $cid, string $p): bool { $r = $db->prepare('SELECT estado FROM periodos WHERE condominio_id = ? AND periodo = ?')->get($cid, $p); return !$r || $r['estado'] === 'abierto'; }
function fechaContable(DB $db, int $cid, string $fecha): string {
  if (periodoAbierto($db, $cid, periodoDe($fecha))) return $fecha;
  $h = hoy();
  if (!periodoAbierto($db, $cid, periodoDe($h))) fail(409, 'El periodo actual está cerrado; no es posible registrar.', 'PERIODO_CERRADO');
  return $h;
}

// ---------- Pólizas ----------
function crearPoliza(DB $db, int $cid, array $o, $user): int {
  $tipo = $o['tipo'] ?? 'D';
  $ls = filt($o['lineas'], fn($l) => ($l['debe'] ?? 0) > 0 || ($l['haber'] ?? 0) > 0);
  if (!$ls) fail(400, 'La póliza no tiene movimientos.');
  $debe = 0; $haber = 0;
  foreach ($ls as $l) {
    $d = $l['debe'] ?? 0; $h = $l['haber'] ?? 0;
    if (!is_int($d) || !is_int($h) || $d < 0 || $h < 0 || ($d > 0 && $h > 0)) fail(400, 'Movimiento contable inválido.');
    if (!$db->prepare('SELECT 1 FROM cuentas WHERE id = ? AND condominio_id = ? AND activo = 1')->get($l['cuenta'], $cid)) fail(400, 'Cuenta contable inválida para este condominio.');
    $debe += $d; $haber += $h;
  }
  if ($debe !== $haber) fail(400, "Póliza descuadrada: cargos {$debe} ≠ abonos {$haber}.");
  $periodo = periodoDe($o['fecha']);
  $db->prepare("INSERT OR IGNORE INTO periodos (condominio_id, periodo, estado) VALUES (?, ?, 'abierto')")->run($cid, $periodo);
  $folio = $db->prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM polizas WHERE condominio_id = ? AND tipo = ?')->get($cid, $tipo)['f'];
  $pid = $db->prepare('INSERT INTO polizas (condominio_id, tipo, folio, fecha, periodo, concepto, origen, origen_id, reversa_de, total_cents, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    ->run($cid, $tipo, $folio, $o['fecha'], $periodo, $o['concepto'], $o['origen'], $o['origen_id'] ?? null, $o['reversa_de'] ?? null, $debe, uid_($user), now_ms())['lastInsertRowid'];
  foreach ($ls as $l) $db->prepare('INSERT INTO movimientos (poliza_id, cuenta_id, unidad_id, debe_cents, haber_cents, concepto) VALUES (?,?,?,?,?,?)')->run($pid, $l['cuenta'], $l['unidad'] ?? null, $l['debe'] ?? 0, $l['haber'] ?? 0, $l['concepto'] ?? null);
  return $pid;
}
function polizaManual(DB $db, int $cid, array $data, $user): int {
  $prohibidas = [cuenta($db, $cid, 'CXC'), cuenta($db, $cid, 'ANTICIPOS')];
  foreach ($data['lineas'] as $l) if (in_array($l['cuenta'], $prohibidas, true)) fail(400, 'Las cuentas de condóminos solo se afectan desde Cobranza (mantiene cuadrados los estados de cuenta).');
  fechaOperable($data['fecha'], 'La fecha de la póliza');
  return crearPoliza($db, $cid, ['tipo' => $data['tipo'], 'fecha' => $data['fecha'], 'concepto' => $data['concepto'], 'origen' => 'manual',
    'lineas' => array_map(fn($l) => ['cuenta' => $l['cuenta'], 'debe' => $l['debe'], 'haber' => $l['haber'], 'concepto' => $l['concepto']], $data['lineas'])], $user);
}
function revertirPoliza(DB $db, int $cid, int $polizaId, string $motivo, $user): int {
  $p = $db->prepare('SELECT * FROM polizas WHERE id = ? AND condominio_id = ?')->get($polizaId, $cid) ?? fail(404, 'Póliza no encontrada');
  if ($p['origen'] !== 'manual') fail(400, 'Solo las pólizas manuales se revierten aquí; las automáticas se revierten cancelando su documento de origen.');
  if ($p['reversada_por']) fail(409, 'La póliza ya fue revertida.');
  $movs = $db->prepare('SELECT * FROM movimientos WHERE poliza_id = ?')->all($polizaId);
  $nid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => fechaContable($db, $cid, hoy()), 'concepto' => "Reversa de {$p['tipo']}-{$p['folio']}: {$motivo}", 'origen' => 'reverso', 'reversa_de' => $p['id'],
    'lineas' => array_map(fn($m) => ['cuenta' => $m['cuenta_id'], 'unidad' => $m['unidad_id'], 'debe' => $m['haber_cents'], 'haber' => $m['debe_cents'], 'concepto' => $m['concepto']], $movs)], $user);
  $db->prepare('UPDATE polizas SET reversada_por = ? WHERE id = ?')->run($nid, $p['id']);
  return $nid;
}

// ---------- Cargos y saldos ----------
function cargosAbiertos(DB $db, int $unidadId): array {
  return $db->prepare('SELECT c.*, ' . SALDO_CARGO . ' AS saldo_cents FROM cargos c WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND ' . SALDO_CARGO . " > 0 ORDER BY c.vencimiento, CASE c.tipo WHEN 'recargo' THEN 0 ELSE 1 END, c.id")->all($unidadId);
}
function creditosDisponibles(DB $db, int $unidadId): array {
  return filt($db->prepare("SELECT p.id, p.fecha, pol.fecha AS fecha_contable, p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0) AS libre
    FROM pagos p LEFT JOIN polizas pol ON pol.id = p.poliza_id WHERE p.unidad_id = ? AND p.estado = 'aplicado' ORDER BY p.fecha, p.id")->all($unidadId), fn($r) => $r['libre'] > 0);
}
function planAplicacion(array $abiertos, int $monto): array {
  $plan = []; $resto = $monto;
  foreach ($abiertos as $c) { if ($resto <= 0) break; $m = min($resto, $c['saldo_cents']); $plan[] = ['cargo_id' => $c['id'], 'monto' => $m]; $resto -= $m; }
  return ['plan' => $plan, 'resto' => $resto];
}
function insAplic(DB $db, int $cid, array $a, $user): void {
  $db->prepare('INSERT INTO aplicaciones (condominio_id, cargo_id, pago_id, tipo, monto_cents, motivo, poliza_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    ->run($cid, $a['cargo_id'], $a['pago_id'] ?? null, $a['tipo'], $a['monto'], $a['motivo'] ?? null, $a['poliza_id'], uid_($user), now_ms());
}
function aplicarSaldoFavor(DB $db, int $cid, int $unidadId, string $fecha, $user): int {
  $creditos = creditosDisponibles($db, $unidadId);
  if (!$creditos) return 0;
  $abiertos = cargosAbiertos($db, $unidadId);
  if (!$abiertos) return 0;
  $pares = [];
  foreach ($creditos as $cr) {
    $plan = planAplicacion($abiertos, $cr['libre'])['plan'];
    foreach ($plan as $p) {
      $pares[] = $p + ['pago_id' => $cr['id'], 'fecha_credito' => $cr['fecha_contable'] ?: $cr['fecha']];
      foreach ($abiertos as &$c) if ($c['id'] === $p['cargo_id']) { $c['saldo_cents'] -= $p['monto']; break; }
      unset($c);
    }
    $abiertos = filt($abiertos, fn($c) => $c['saldo_cents'] > 0);
    if (!$abiertos) break;
  }
  $total = suma($pares, 'monto');
  if (!$total) return 0;
  $u = unidadDe($db, $cid, $unidadId);
  $f = $fecha; foreach ($pares as $p) if ($p['fecha_credito'] > $f) $f = $p['fecha_credito'];
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => fechaContable($db, $cid, $f), 'concepto' => "Aplicación de saldo a favor · {$u['clave']}", 'origen' => 'aplicacion_anticipo', 'origen_id' => $unidadId, 'lineas' => [
    ['cuenta' => cuenta($db, $cid, 'ANTICIPOS'), 'unidad' => $unidadId, 'debe' => $total, 'concepto' => 'Aplicación de saldo a favor'],
    ['cuenta' => cuenta($db, $cid, 'CXC'), 'unidad' => $unidadId, 'haber' => $total, 'concepto' => 'Aplicación de saldo a favor'],
  ]], $user);
  foreach ($pares as $p) insAplic($db, $cid, ['cargo_id' => $p['cargo_id'], 'monto' => $p['monto'], 'pago_id' => $p['pago_id'], 'tipo' => 'pago', 'poliza_id' => $pid], $user);
  return $total;
}
function insertarCargos(DB $db, int $cid, array $cargos, array $o, $user): array {
  $nuevos = filt($cargos, fn($c) => $c['monto'] > 0 && !$db->prepare('SELECT 1 FROM cargos WHERE dedupe_key = ?')->get($c['dedupe']));
  if (!$nuevos) return ['emitidos' => 0, 'omitidos' => count($cargos), 'total' => 0];
  $cxc = cuenta($db, $cid, 'CXC'); $res = cuenta($db, $cid, 'FONDO_RESERVA');
  $porCuenta = []; $porFondo = []; $lineas = [];
  foreach ($nuevos as &$c) {
    $ci = cuenta($db, $cid, $c['cuentaClave'] ?? CUENTA_CARGO[$c['tipo']]);
    $c['cuenta'] = $ci;
    $porCuenta[$ci] = ($porCuenta[$ci] ?? 0) + $c['monto'] - $c['reserva'];
    $f = $c['fondoCuenta'] ?? null ?: $res;
    $porFondo[$f] = ($porFondo[$f] ?? 0) + $c['reserva'];
    $lineas[] = ['cuenta' => $cxc, 'unidad' => $c['unidad'], 'debe' => $c['monto'], 'concepto' => $c['concepto']];
  }
  unset($c);
  foreach ($porCuenta as $ci => $m) if ($m > 0) $lineas[] = ['cuenta' => $ci, 'haber' => $m, 'concepto' => $o['concepto']];
  foreach ($porFondo as $f => $m) if ($m > 0) $lineas[] = ['cuenta' => $f, 'haber' => $m, 'concepto' => "{$o['concepto']} · aportación a " . ($f === $res ? 'fondo de reserva' : 'fondo')];
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => $o['fecha'], 'concepto' => $o['concepto'], 'origen' => $o['origen'], 'lineas' => $lineas], $user);
  foreach ($nuevos as $c) $db->prepare('INSERT INTO cargos (condominio_id, unidad_id, tipo, concepto, periodo, fecha, vencimiento, monto_cents, reserva_cents, cuenta_ingreso_id, poliza_id, lote, dedupe_key, fondo_cuenta_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    ->run($cid, $c['unidad'], $c['tipo'], $c['concepto'], $c['periodo'], $o['fecha'], $c['vencimiento'], $c['monto'], $c['reserva'], $c['cuenta'], $pid, $c['lote'] ?? null, $c['dedupe'], $c['reserva'] && !empty($c['fondoCuenta']) ? $c['fondoCuenta'] : null, uid_($user), now_ms());
  foreach (array_unique(col($nuevos, 'unidad')) as $uid) aplicarSaldoFavor($db, $cid, $uid, $o['fecha'], $user);
  return ['emitidos' => count($nuevos), 'omitidos' => count($cargos) - count($nuevos), 'total' => suma($nuevos, 'monto'), 'poliza_id' => $pid];
}
function vencimientoDe(array $c, string $periodo): string { return $periodo . '-' . pad2((int)$c['dia_vencimiento']); }

function emitirCuotas(DB $db, int $cid, string $periodo, $user, ?string $fecha = null): array {
  $fecha ??= "{$periodo}-01";
  $c = condo($db, $cid);
  $unidades = $db->prepare('SELECT * FROM unidades WHERE condominio_id = ? AND activo = 1 AND cuota_cents > 0 ORDER BY clave')->all($cid);
  $rec = cargosRecurrentesDe($db, $cid, $periodo);
  if (!$unidades && !$rec) fail(400, 'No hay unidades activas con cuota asignada.');
  $concepto = 'Cuota ordinaria ' . nombrePeriodo($periodo);
  $cargos = array_map(fn($u) => ['unidad' => $u['id'], 'tipo' => 'ordinaria', 'concepto' => $concepto, 'periodo' => $periodo, 'vencimiento' => vencimientoDe($c, $periodo), 'monto' => $u['cuota_cents'],
    'reserva' => jround($u['cuota_cents'] * $c['pct_reserva_bp'] / 10000), 'dedupe' => "ORD:{$u['id']}:{$periodo}"], $unidades);
  foreach ($rec as $r) $cargos[] = $r + ['vencimiento' => vencimientoDe($c, $periodo)];
  return insertarCargos($db, $cid, $cargos, ['concepto' => 'Emisión de cuotas ordinarias · ' . nombrePeriodo($periodo), 'fecha' => $fecha, 'origen' => 'emision'], $user);
}
function cargosRecurrentesDe(DB $db, int $cid, string $periodo): array {
  $rs = $db->prepare('SELECT * FROM cargos_recurrentes WHERE condominio_id = ? AND activo = 1 AND desde <= ? AND (hasta IS NULL OR hasta >= ?)')->all($cid, $periodo, $periodo);
  $activas = col($db->prepare('SELECT id FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave')->all($cid), 'id');
  $out = [];
  foreach ($rs as $r) foreach ($r['unidad_id'] ? filt([$r['unidad_id']], fn($x) => in_array($x, $activas, true)) : $activas as $uid)
    $out[] = ['unidad' => $uid, 'tipo' => $r['tipo'], 'concepto' => "{$r['concepto']} " . nombrePeriodo($periodo), 'periodo' => $periodo, 'monto' => $r['monto_cents'], 'reserva' => 0, 'dedupe' => "RCU:{$r['id']}:{$uid}:{$periodo}"];
  return $out;
}
function crearCargoRecurrente(DB $db, int $cid, array $d, $user): int {
  if (!empty($d['unidad_id'])) unidadDe($db, $cid, $d['unidad_id']);
  if (!empty($d['hasta']) && $d['hasta'] < $d['desde']) fail(400, 'El periodo final es anterior al inicial.');
  return $db->prepare('INSERT INTO cargos_recurrentes (condominio_id, unidad_id, tipo, concepto, monto_cents, desde, hasta, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    ->run($cid, $d['unidad_id'] ?? null, $d['tipo'], $d['concepto'], $d['monto_cents'], $d['desde'], $d['hasta'] ?? null, uid_($user), now_ms())['lastInsertRowid'];
}

// ---------- Fondos ----------
function crearFondo(DB $db, int $cid, array $d, $user): int {
  if ($db->prepare('SELECT 1 FROM fondos WHERE condominio_id = ? AND nombre = ? COLLATE NOCASE')->get($cid, $d['nombre'])) fail(409, 'Ya existe un fondo con ese nombre.', 'DUPLICADO');
  $n = $db->prepare("SELECT COUNT(*) n FROM cuentas WHERE condominio_id = ? AND codigo LIKE '3102-%'")->get($cid)['n'] + 1;
  $k = $db->prepare("INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza) VALUES (?,?,?,'patrimonio','A')")->run($cid, '3102-' . pad2($n), "Fondo · {$d['nombre']}")['lastInsertRowid'];
  return $db->prepare('INSERT INTO fondos (condominio_id, nombre, cuenta_id, meta_cents, descripcion, created_by, created_at) VALUES (?,?,?,?,?,?,?)')->run($cid, $d['nombre'], $k, $d['meta_cents'] ?? null, $d['descripcion'] ?? null, uid_($user), now_ms())['lastInsertRowid'];
}
function fondoDe(DB $db, int $cid, $id): array { return $db->prepare('SELECT * FROM fondos WHERE id = ? AND condominio_id = ? AND activo = 1')->get($id, $cid) ?? fail(400, 'Fondo inválido.'); }

function emitirExtraordinaria(DB $db, int $cid, array $d, $user): array {
  $c = condo($db, $cid);
  $fondo = ($d['destino'] ?? null) === 'fondo' ? fondoDe($db, $cid, $d['fondo_id']) : null;
  $unidades = $db->prepare('SELECT * FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave')->all($cid);
  if (!empty($d['unidades'])) { $s = array_map('intval', $d['unidades']); $unidades = filt($unidades, fn($u) => in_array($u['id'], $s, true)); }
  if (!$unidades) fail(400, 'Seleccione al menos una unidad.');
  $pesos = ($d['metodo'] ?? null) === 'igual' ? array_fill(0, count($unidades), 1) : col($unidades, 'indiviso_ppm');
  $partes = prorratear($d['total_cents'], $pesos);
  $lote = 'EXT-' . token(6); $periodo = periodoDe($d['fecha']);
  $cargos = [];
  foreach ($unidades as $i => $u) $cargos[] = ['unidad' => $u['id'], 'tipo' => 'extraordinaria', 'concepto' => $d['concepto'], 'periodo' => $periodo, 'vencimiento' => ($d['vencimiento'] ?? null) ?: vencimientoDe($c, $periodo),
    'monto' => $partes[$i], 'reserva' => ($d['destino'] ?? null) !== 'operacion' ? $partes[$i] : 0, 'fondoCuenta' => $fondo['cuenta_id'] ?? null, 'dedupe' => "EXT:{$lote}:{$u['id']}", 'lote' => $lote];
  return ['lote' => $lote] + insertarCargos($db, $cid, $cargos, ['concepto' => "Cuota extraordinaria · {$d['concepto']}", 'fecha' => $d['fecha'], 'origen' => 'extraordinaria'], $user);
}
function cargoIndividual(DB $db, int $cid, array $d, $user): array {
  unidadDe($db, $cid, $d['unidad_id']);
  return insertarCargos($db, $cid, [['unidad' => $d['unidad_id'], 'tipo' => $d['tipo'], 'concepto' => $d['concepto'], 'periodo' => periodoDe($d['fecha']), 'vencimiento' => ($d['vencimiento'] ?? null) ?: $d['fecha'],
    'monto' => $d['monto_cents'], 'reserva' => 0, 'dedupe' => 'IND:' . token(9)]], ['concepto' => $d['concepto'], 'fecha' => $d['fecha'], 'origen' => 'cargo'], $user);
}
function calcularRecargos(DB $db, int $cid, string $periodo, $user): array {
  $c = condo($db, $cid);
  $modo = $c['recargo_modo'] ?: 'saldo';
  if ($modo === 'fijo' ? !$c['recargo_fijo_cents'] : !$c['tasa_recargo_bp']) fail(400, $modo === 'fijo' ? 'El recargo fijo está en $0.' : 'La tasa de recargos está en 0%.');
  $corte = "{$periodo}-01";
  $conv = col($db->prepare("SELECT unidad_id FROM convenios WHERE condominio_id = ? AND estado = 'vigente' AND suspende_recargos = 1")->all($cid), 'unidad_id');
  $rows = $db->prepare('SELECT c.unidad_id, c.vencimiento, c.monto_cents, ' . SALDO_CARGO . " AS saldo FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.tipo IN ('ordinaria','extraordinaria')")->all($cid);
  $porUnidad = [];
  foreach ($rows as $r) {
    if ($r['saldo'] <= 0 || addDays($r['vencimiento'], (int)$c['dias_gracia']) >= $corte || in_array($r['unidad_id'], $conv, true)) continue;
    $u = $porUnidad[$r['unidad_id']] ?? ['saldo' => 0, 'cuotas' => 0, 'base' => 0];
    $u['saldo'] += $r['saldo']; $u['cuotas']++; $u['base'] += $r['monto_cents'];
    $porUnidad[$r['unidad_id']] = $u;
  }
  $pct = pctTxt((int)$c['tasa_recargo_bp']); $np = nombrePeriodo($periodo);
  $cargos = [];
  foreach ($porUnidad as $uid => $u) {
    $monto = $modo === 'fijo' ? $u['cuotas'] * $c['recargo_fijo_cents'] : jround(($modo === 'cuota' ? $u['base'] : $u['saldo']) * $c['tasa_recargo_bp'] / 10000);
    $texto = $modo === 'fijo' ? "Recargo fijo {$np} · {$u['cuotas']} " . ($u['cuotas'] === 1 ? 'cuota vencida' : 'cuotas vencidas')
      : ($modo === 'cuota' ? "Recargo {$pct}% sobre " . ($u['cuotas'] === 1 ? 'la cuota vencida' : "{$u['cuotas']} cuotas vencidas") . " {$np}" : "Recargo {$pct}% {$np} sobre saldo vencido");
    $cargos[] = ['unidad' => $uid, 'tipo' => 'recargo', 'concepto' => $texto, 'periodo' => $periodo, 'vencimiento' => vencimientoDe($c, $periodo), 'monto' => $monto, 'reserva' => 0, 'dedupe' => "REC:{$uid}:{$periodo}"];
  }
  return insertarCargos($db, $cid, $cargos, ['concepto' => "Recargos por mora · {$np}", 'fecha' => $corte, 'origen' => 'recargos'], $user);
}
function recargoManual(DB $db, int $cid, array $d, $user): array {
  $cg = $db->prepare('SELECT c.*, ' . SALDO_CARGO . ' AS saldo FROM cargos c WHERE c.id = ? AND c.condominio_id = ?')->get($d['cargo_id'], $cid) ?? fail(404, 'Cuota no encontrada.');
  if ($cg['cancelado_at']) fail(409, 'La cuota está cancelada.');
  if (!in_array($cg['tipo'], ['ordinaria', 'extraordinaria', 'otro'], true)) fail(400, 'Solo se aplican recargos a cuotas (no a otros recargos).');
  $monto = $d['modo'] === 'porcentaje' ? jround($cg['monto_cents'] * $d['porcentaje_bp'] / 10000) : $d['monto_cents'];
  if (!($monto > 0)) fail(400, 'El recargo debe ser mayor a cero.');
  $periodo = periodoDe($d['fecha']);
  $concepto = mslice(($d['concepto'] ?? null) ?: ($d['modo'] === 'porcentaje' ? 'Recargo ' . pctTxt((int)$d['porcentaje_bp']) . "% sobre {$cg['concepto']}" : "Recargo sobre {$cg['concepto']}"), 0, 120);
  $r = insertarCargos($db, $cid, [['unidad' => $cg['unidad_id'], 'tipo' => 'recargo', 'concepto' => $concepto, 'periodo' => $periodo, 'vencimiento' => $d['fecha'], 'monto' => $monto, 'reserva' => 0, 'dedupe' => "RECM:{$cg['id']}:{$periodo}"]],
    ['concepto' => $concepto, 'fecha' => $d['fecha'], 'origen' => 'recargos'], $user);
  if (!$r['emitidos']) fail(409, 'Esa cuota ya tiene un recargo aplicado este mes.', 'DUPLICADO');
  return $r + ['monto' => $monto];
}
function bonificar(DB $db, int $cid, int $cargoId, int $monto, string $motivo, $user, ?string $fechaAplica = null): int {
  $c = $db->prepare('SELECT c.*, ' . SALDO_CARGO . ' AS saldo_cents FROM cargos c WHERE c.id = ? AND c.condominio_id = ?')->get($cargoId, $cid) ?? fail(404, 'Cargo no encontrado');
  if ($c['cancelado_at']) fail(409, 'El cargo está cancelado.');
  if ($monto > $c['saldo_cents']) fail(400, 'La bonificación excede el saldo del cargo.');
  $resPart = jround($monto * $c['reserva_cents'] / $c['monto_cents']);
  $fecha = fechaContable($db, $cid, $fechaAplica ?: hoy());
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => $fecha, 'concepto' => "Bonificación: {$c['concepto']} · {$motivo}", 'origen' => 'bonificacion', 'origen_id' => $c['id'], 'lineas' => [
    ['cuenta' => cuenta($db, $cid, 'BONIF'), 'debe' => $monto - $resPart, 'concepto' => $motivo],
    ['cuenta' => $c['fondo_cuenta_id'] ?: cuenta($db, $cid, 'FONDO_RESERVA'), 'debe' => $resPart, 'concepto' => $motivo],
    ['cuenta' => cuenta($db, $cid, 'CXC'), 'unidad' => $c['unidad_id'], 'haber' => $monto, 'concepto' => ($motivo === MOTIVO_PRONTO_PAGO ? MOTIVO_PRONTO_PAGO : 'Bonificación') . ": {$c['concepto']}"],
  ]], $user);
  insAplic($db, $cid, ['cargo_id' => $c['id'], 'tipo' => 'bonificacion', 'monto' => $monto, 'motivo' => $motivo, 'poliza_id' => $pid], $user);
  return $pid;
}
function cancelarCargo(DB $db, int $cid, int $cargoId, string $motivo, $user): int {
  $c = $db->prepare('SELECT * FROM cargos WHERE id = ? AND condominio_id = ?')->get($cargoId, $cid) ?? fail(404, 'Cargo no encontrado');
  if ($c['cancelado_at']) fail(409, 'El cargo ya está cancelado.');
  if ($db->prepare('SELECT COUNT(*) n FROM aplicaciones WHERE cargo_id = ? AND revertida = 0')->get($c['id'])['n']) fail(409, 'El cargo tiene pagos o bonificaciones aplicados; cancele primero esos movimientos o use bonificación.');
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => fechaContable($db, $cid, hoy()), 'concepto' => "Cancelación de cargo: {$c['concepto']} · {$motivo}", 'origen' => 'cancelacion_cargo', 'origen_id' => $c['id'], 'lineas' => [
    ['cuenta' => $c['cuenta_ingreso_id'], 'debe' => $c['monto_cents'] - $c['reserva_cents'], 'concepto' => $motivo],
    ['cuenta' => $c['fondo_cuenta_id'] ?: cuenta($db, $cid, 'FONDO_RESERVA'), 'debe' => $c['reserva_cents'], 'concepto' => $motivo],
    ['cuenta' => cuenta($db, $cid, 'CXC'), 'unidad' => $c['unidad_id'], 'haber' => $c['monto_cents'], 'concepto' => "Cancelación: {$c['concepto']}"],
  ]], $user);
  $db->prepare('UPDATE cargos SET cancelado_at = ?, cancelado_por = ?, motivo_cancel = ?, cancel_poliza_id = ? WHERE id = ?')->run(now_ms(), uid_($user), $motivo, $pid, $c['id']);
  return $pid;
}

// ---------- Pagos ----------
function esSaldoInicial($p): bool { return is_array($p) && is_string($p['idem_key'] ?? null) && str_starts_with($p['idem_key'], 'INI-'); }
function cuentaDeCobro(DB $db, int $cid, array $pago): int {
  if (esSaldoInicial($pago)) return cuenta($db, $cid, 'REMANENTE');
  if (!empty($pago['cuenta_banco_id'])) {
    $b = $db->prepare('SELECT cuenta_id FROM cuentas_banco WHERE id = ? AND condominio_id = ? AND activo = 1')->get($pago['cuenta_banco_id'], $cid);
    if (!$b) fail(400, 'Cuenta bancaria inválida.');
    return $b['cuenta_id'];
  }
  if (($pago['metodo'] ?? null) !== 'efectivo') fail(400, 'Indique la cuenta bancaria donde se recibió el pago.');
  return cuenta($db, $cid, 'CAJA');
}
function posiblesDuplicados(DB $db, int $cid, array $d): array {
  return $db->prepare("SELECT id, folio, fecha, monto_cents, referencia, estado FROM pagos WHERE condominio_id = ? AND unidad_id = ? AND monto_cents = ? AND estado IN ('por_validar','aplicado') AND ABS(julianday(fecha) - julianday(?)) <= 3")
    ->all($cid, $d['unidad_id'], $d['monto_cents'], $d['fecha']);
}
function descuentoProntoPago(DB $db, int $cid, array $u, array $pago, string $fecha, $user): int {
  $c = condo($db, $cid);
  if (!$c['pronto_pago_bp'] || !$c['pronto_pago_dia']) return 0;
  $resto = $pago['monto_cents']; $total = 0;
  foreach (cargosAbiertos($db, $u['id']) as $cg) {
    if ($resto <= 0) break;
    $limite = $cg['periodo'] . '-' . pad2((int)$c['pronto_pago_dia']);
    $eleg = $cg['tipo'] === 'ordinaria' && $cg['saldo_cents'] === $cg['monto_cents'] && $pago['fecha'] <= $limite
      && !$db->prepare("SELECT 1 FROM aplicaciones WHERE cargo_id = ? AND tipo = 'bonificacion' AND revertida = 0 AND motivo = ?")->get($cg['id'], MOTIVO_PRONTO_PAGO);
    $desc = $eleg ? jround($cg['monto_cents'] * $c['pronto_pago_bp'] / 10000) : 0;
    if ($desc > 0 && $resto >= $cg['saldo_cents'] - $desc) { bonificar($db, $cid, $cg['id'], $desc, MOTIVO_PRONTO_PAGO, $user, $fecha); $resto -= $cg['saldo_cents'] - $desc; $total += $desc; }
    else $resto -= min($resto, $cg['saldo_cents']);
  }
  return $total;
}
function contabilizarPago(DB $db, int $cid, array $pago, $user): array {
  $u = unidadDe($db, $cid, $pago['unidad_id']);
  $fecha = fechaContable($db, $cid, $pago['fecha']);
  $descuento = descuentoProntoPago($db, $cid, $u, $pago, $fecha, $user);
  ['plan' => $plan, 'resto' => $resto] = planAplicacion(cargosAbiertos($db, $u['id']), $pago['monto_cents']);
  $aplicado = $pago['monto_cents'] - $resto;
  $folio = $pago['folio'] ?? $db->prepare('SELECT COALESCE(MAX(folio), 0) + 1 f FROM pagos WHERE condominio_id = ?')->get($cid)['f'];
  $ref = $pago['referencia'] ? " ref. {$pago['referencia']}" : '';
  $pid = crearPoliza($db, $cid, ['tipo' => 'I', 'fecha' => $fecha, 'concepto' => "Cobro recibo R-{$folio} · {$u['clave']} · {$pago['metodo']}{$ref}", 'origen' => 'pago', 'origen_id' => $pago['id'], 'lineas' => [
    ['cuenta' => cuentaDeCobro($db, $cid, $pago), 'debe' => $pago['monto_cents'], 'concepto' => "Cobro {$u['clave']}"],
    ['cuenta' => cuenta($db, $cid, 'CXC'), 'unidad' => $u['id'], 'haber' => $aplicado, 'concepto' => "Pago recibo R-{$folio}{$ref}"],
    ['cuenta' => cuenta($db, $cid, 'ANTICIPOS'), 'unidad' => $u['id'], 'haber' => $resto, 'concepto' => "Saldo a favor · recibo R-{$folio}"],
  ]], $user);
  foreach ($plan as $p) insAplic($db, $cid, $p + ['pago_id' => $pago['id'], 'tipo' => 'pago', 'poliza_id' => $pid], $user);
  $db->prepare("UPDATE pagos SET estado = 'aplicado', folio = ?, poliza_id = ?, validado_por = ?, validado_at = ? WHERE id = ?")->run($folio, $pid, uid_($user), now_ms(), $pago['id']);
  return ['folio' => $folio, 'aplicado' => $aplicado, 'saldo_favor' => $resto, 'descuento' => $descuento];
}
function registrarPago(DB $db, int $cid, array $d, $user, bool $validar = true): array {
  $prev = $db->prepare('SELECT * FROM pagos WHERE idem_key = ?')->get($d['idem_key']);
  if ($prev) { if ($prev['condominio_id'] !== $cid) fail(409, 'Clave de operación duplicada.'); return ['id' => $prev['id'], 'folio' => $prev['folio'], 'estado' => $prev['estado'], 'repetido' => true]; }
  unidadDe($db, $cid, $d['unidad_id']);
  fechaOperable($d['fecha'], 'La fecha de pago');
  if (!empty($d['cuenta_banco_id']) && !$db->prepare('SELECT 1 FROM cuentas_banco WHERE id = ? AND condominio_id = ? AND activo = 1')->get($d['cuenta_banco_id'], $cid)) fail(400, 'Cuenta bancaria inválida.');
  if (!empty($d['comprobante_id']) && !$db->prepare('SELECT 1 FROM archivos WHERE id = ? AND condominio_id = ?')->get($d['comprobante_id'], $cid)) fail(400, 'Comprobante inválido.');
  if (!empty($d['cuenta_banco_id']) && !empty($d['referencia'])) {
    $dup = $db->prepare("SELECT folio FROM pagos WHERE condominio_id = ? AND cuenta_banco_id = ? AND referencia = ? AND monto_cents = ? AND estado IN ('por_validar','aplicado')")->get($cid, $d['cuenta_banco_id'], $d['referencia'], $d['monto_cents']);
    if ($dup) fail(409, 'Ya existe un pago con la misma referencia bancaria e importe' . ($dup['folio'] ? " (recibo R-{$dup['folio']})" : '') . '.', 'DUPLICADO');
  }
  if (empty($d['confirmar_duplicado']) && posiblesDuplicados($db, $cid, $d)) fail(409, 'Existe un pago de la misma unidad y monto en un rango de ±3 días. Confirme si no es duplicado.', 'POSIBLE_DUPLICADO');
  $id = $db->prepare('INSERT INTO pagos (condominio_id, unidad_id, fecha, monto_cents, metodo, referencia, cuenta_banco_id, comprobante_id, estado, idem_key, notas, reportado_por, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    ->run($cid, $d['unidad_id'], $d['fecha'], $d['monto_cents'], $d['metodo'], $d['referencia'] ?? null, $d['cuenta_banco_id'] ?? null, $d['comprobante_id'] ?? null, 'por_validar', $d['idem_key'], $d['notas'] ?? null, $validar ? null : uid_($user), uid_($user), now_ms())['lastInsertRowid'];
  $pago = $db->prepare('SELECT * FROM pagos WHERE id = ?')->get($id);
  if (!$validar) return ['id' => $pago['id'], 'estado' => 'por_validar'];
  return ['id' => $pago['id'], 'estado' => 'aplicado'] + contabilizarPago($db, $cid, $pago, $user);
}
function validarPago(DB $db, int $cid, int $pagoId, array $d, $user): array {
  $p = $db->prepare('SELECT * FROM pagos WHERE id = ? AND condominio_id = ?')->get($pagoId, $cid) ?? fail(404, 'Pago no encontrado');
  if ($p['estado'] !== 'por_validar') fail(409, 'El pago ya fue procesado.');
  if (!empty($d['aceptar'])) {
    if (!empty($d['cuenta_banco_id'])) $db->prepare('UPDATE pagos SET cuenta_banco_id = ? WHERE id = ?')->run($d['cuenta_banco_id'], $p['id']);
    return contabilizarPago($db, $cid, $db->prepare('SELECT * FROM pagos WHERE id = ?')->get($p['id']), $user);
  }
  $db->prepare("UPDATE pagos SET estado = 'rechazado', motivo = ?, validado_por = ?, validado_at = ? WHERE id = ?")->run(($d['motivo'] ?? null) ?: 'Rechazado', $user['id'], now_ms(), $p['id']);
  return ['rechazado' => true];
}
function cancelarPago(DB $db, int $cid, int $pagoId, string $motivo, $user): array|stdClass {
  $p = $db->prepare('SELECT * FROM pagos WHERE id = ? AND condominio_id = ?')->get($pagoId, $cid) ?? fail(404, 'Pago no encontrado');
  if ($p['estado'] === 'por_validar') { $db->prepare("UPDATE pagos SET estado = 'rechazado', motivo = ? WHERE id = ?")->run($motivo, $p['id']); return new stdClass(); }
  if ($p['estado'] !== 'aplicado') fail(409, 'El pago ya está cancelado o rechazado.');
  $aplicado = $db->prepare('SELECT COALESCE(SUM(monto_cents), 0) s FROM aplicaciones WHERE pago_id = ? AND revertida = 0')->get($p['id'])['s'];
  $libre = $p['monto_cents'] - $aplicado;
  $u = unidadDe($db, $cid, $p['unidad_id']);
  $doc = $p['folio'] ? "recibo R-{$p['folio']}" : 'saldo a favor inicial';
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => fechaContable($db, $cid, hoy()), 'concepto' => "Cancelación {$doc} · {$u['clave']} · {$motivo}", 'origen' => 'cancelacion_pago', 'origen_id' => $p['id'], 'reversa_de' => $p['poliza_id'], 'lineas' => [
    ['cuenta' => cuenta($db, $cid, 'CXC'), 'unidad' => $u['id'], 'debe' => $aplicado, 'concepto' => "Cancelación {$doc}"],
    ['cuenta' => cuenta($db, $cid, 'ANTICIPOS'), 'unidad' => $u['id'], 'debe' => $libre, 'concepto' => "Cancelación {$doc}"],
    ['cuenta' => cuentaDeCobro($db, $cid, $p), 'haber' => $p['monto_cents'], 'concepto' => "Cancelación {$doc}"],
  ]], $user);
  $db->prepare('UPDATE aplicaciones SET revertida = 1 WHERE pago_id = ? AND revertida = 0')->run($p['id']);
  $db->prepare("UPDATE pagos SET estado = 'cancelado', motivo = ?, cancel_poliza_id = ? WHERE id = ?")->run($motivo, $pid, $p['id']);
  if ($p['poliza_id']) $db->prepare('UPDATE polizas SET reversada_por = ? WHERE id = ? AND reversada_por IS NULL')->run($pid, $p['poliza_id']);
  $db->prepare("UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE conciliado_tipo = 'pago' AND conciliado_id = ?")->run($p['id']);
  return ['poliza_id' => $pid];
}

// ---------- Saldos iniciales ----------
function saldoInicial(DB $db, int $cid, array $d, $user): array {
  $u = unidadDe($db, $cid, $d['unidad_id']);
  if (!$d['monto_cents']) fail(400, 'El saldo es cero; no hay nada que registrar.');
  $concepto = ($d['concepto'] ?? null) ?: "Saldo inicial al {$d['fecha']}";
  if ($d['monto_cents'] > 0) {
    if ($db->prepare('SELECT 1 FROM cargos WHERE dedupe_key = ?')->get("INI:{$u['id']}")) return ['omitido' => true, 'motivo' => 'La unidad ya tiene adeudo inicial registrado.'];
    $r = insertarCargos($db, $cid, [['unidad' => $u['id'], 'tipo' => 'otro', 'cuentaClave' => 'REMANENTE', 'concepto' => $concepto, 'periodo' => periodoDe($d['fecha']), 'vencimiento' => $d['fecha'], 'monto' => $d['monto_cents'], 'reserva' => 0, 'dedupe' => "INI:{$u['id']}"]],
      ['concepto' => "Saldo inicial · {$u['clave']}", 'fecha' => $d['fecha'], 'origen' => 'saldo_inicial'], $user);
    return ['tipo' => 'adeudo', 'monto' => $d['monto_cents'], 'poliza_id' => $r['poliza_id']];
  }
  $key = "INI-{$cid}-{$u['id']}";
  if ($db->prepare('SELECT 1 FROM pagos WHERE idem_key = ?')->get($key)) return ['omitido' => true, 'motivo' => 'La unidad ya tiene saldo a favor inicial registrado.'];
  $monto = -$d['monto_cents'];
  $pagoId = $db->prepare("INSERT INTO pagos (condominio_id, unidad_id, fecha, monto_cents, metodo, estado, idem_key, notas, created_by, created_at) VALUES (?,?,?,?,'deposito','por_validar',?,?,?,?)")
    ->run($cid, $u['id'], $d['fecha'], $monto, $key, mslice($concepto, 0, 300), uid_($user), now_ms())['lastInsertRowid'];
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => $d['fecha'], 'concepto' => "Saldo a favor inicial · {$u['clave']}", 'origen' => 'saldo_inicial', 'origen_id' => $pagoId, 'lineas' => [
    ['cuenta' => cuenta($db, $cid, 'REMANENTE'), 'debe' => $monto, 'concepto' => $concepto],
    ['cuenta' => cuenta($db, $cid, 'ANTICIPOS'), 'unidad' => $u['id'], 'haber' => $monto, 'concepto' => $concepto],
  ]], $user);
  $db->prepare("UPDATE pagos SET estado = 'aplicado', poliza_id = ?, validado_por = ?, validado_at = ? WHERE id = ?")->run($pid, uid_($user), now_ms(), $pagoId);
  aplicarSaldoFavor($db, $cid, $u['id'], $d['fecha'], $user);
  return ['tipo' => 'favor', 'monto' => $monto, 'poliza_id' => $pid];
}

// ---------- Egresos ----------
function provisionarEgreso(DB $db, int $cid, array $e, $user): void {
  $prov = $e['proveedor_id'] ? ($db->prepare('SELECT nombre FROM proveedores WHERE id = ?')->get($e['proveedor_id'])['nombre'] ?? null) : null;
  $destino = $e['fondo'] !== 'reserva' ? $e['cuenta_id'] : ($e['fondo_id'] ? fondoDe($db, $cid, $e['fondo_id'])['cuenta_id'] : cuenta($db, $cid, 'FONDO_RESERVA'));
  $pid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => fechaContable($db, $cid, $e['fecha']), 'concepto' => "Provisión E-{$e['folio']} · {$e['concepto']}" . ($prov ? ' · ' . $prov : ''), 'origen' => 'egreso', 'origen_id' => $e['id'], 'lineas' => [
    ['cuenta' => $destino, 'debe' => $e['total_cents'], 'concepto' => $e['concepto']],
    ['cuenta' => cuenta($db, $cid, 'CXP'), 'haber' => $e['total_cents'], 'concepto' => $prov ?: $e['concepto']],
  ]], $user);
  $db->prepare("UPDATE egresos SET estado = 'aprobado', aprobado_por = ?, aprobado_at = ?, poliza_prov_id = ? WHERE id = ?")->run(uid_($user), now_ms(), $pid, $e['id']);
}
function crearEgreso(DB $db, int $cid, array $d, $user): array {
  $prev = $db->prepare('SELECT id, folio, estado, condominio_id FROM egresos WHERE idem_key = ?')->get($d['idem_key']);
  if ($prev) { if ($prev['condominio_id'] !== $cid) fail(409, 'Clave de operación duplicada.'); return ['id' => $prev['id'], 'folio' => $prev['folio'], 'estado' => $prev['estado'], 'repetido' => true]; }
  fechaOperable($d['fecha'], 'La fecha del gasto');
  if (!empty($d['comprobante_id']) && !$db->prepare('SELECT 1 FROM archivos WHERE id = ? AND condominio_id = ?')->get($d['comprobante_id'], $cid)) fail(400, 'Comprobante inválido.');
  $c = condo($db, $cid);
  if (!$db->prepare("SELECT id FROM cuentas WHERE id = ? AND condominio_id = ? AND tipo = 'egreso' AND activo = 1")->get($d['cuenta_id'], $cid)) fail(400, 'Seleccione una partida de gasto válida.');
  if (!empty($d['proveedor_id']) && !$db->prepare('SELECT 1 FROM proveedores WHERE id = ? AND condominio_id = ?')->get($d['proveedor_id'], $cid)) fail(400, 'Proveedor inválido.');
  $total = $d['subtotal_cents'] + $d['iva_cents'] - $d['retenciones_cents'];
  if ($total <= 0) fail(400, 'El total del egreso debe ser mayor a cero.');
  if (!empty($d['cfdi_uuid']) && $db->prepare("SELECT 1 FROM egresos WHERE condominio_id = ? AND cfdi_uuid = ? COLLATE NOCASE AND estado NOT IN ('cancelado','rechazado')")->get($cid, $d['cfdi_uuid'])) fail(409, 'Esta factura (UUID) ya fue registrada.', 'DUPLICADO');
  if (!empty($d['proveedor_id']) && !empty($d['factura_folio']) && $db->prepare("SELECT 1 FROM egresos WHERE condominio_id = ? AND proveedor_id = ? AND factura_folio = ? AND estado NOT IN ('cancelado','rechazado')")->get($cid, $d['proveedor_id'], $d['factura_folio']))
    fail(409, 'Este proveedor ya tiene registrada una factura con ese folio.', 'DUPLICADO');
  $folio = $db->prepare('SELECT COALESCE(MAX(folio), 0) + 1 f FROM egresos WHERE condominio_id = ?')->get($cid)['f'];
  $fondoId = !empty($d['fondo_id']) ? fondoDe($db, $cid, $d['fondo_id'])['id'] : null;
  $id = $db->prepare('INSERT INTO egresos (condominio_id, folio, proveedor_id, cuenta_id, fondo, fondo_id, fecha, concepto, subtotal_cents, iva_cents, retenciones_cents, total_cents, factura_folio, cfdi_uuid, estado, comprobante_id, idem_key, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    ->run($cid, $folio, $d['proveedor_id'] ?? null, $d['cuenta_id'], $fondoId ? 'reserva' : (($d['fondo'] ?? null) ?: 'operacion'), $fondoId, $d['fecha'], $d['concepto'], $d['subtotal_cents'], $d['iva_cents'], $d['retenciones_cents'], $total,
      $d['factura_folio'] ?? null, $d['cfdi_uuid'] ?? null, 'por_aprobar', $d['comprobante_id'] ?? null, $d['idem_key'], $user['id'], now_ms())['lastInsertRowid'];
  $e = $db->prepare('SELECT * FROM egresos WHERE id = ?')->get($id);
  $requiere = $total >= $c['umbral_aprobacion_cents'] || $e['fondo'] === 'reserva';
  if (!$requiere) provisionarEgreso($db, $cid, $e, $user);
  return ['id' => $e['id'], 'folio' => $folio, 'estado' => $requiere ? 'por_aprobar' : 'aprobado', 'requiere_aprobacion' => $requiere];
}
function aprobarEgreso(DB $db, int $cid, int $id, bool $aprobar, ?string $motivo, $user): array {
  $e = $db->prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?')->get($id, $cid) ?? fail(404, 'Egreso no encontrado');
  if ($e['estado'] !== 'por_aprobar') fail(409, 'El egreso no está pendiente de aprobación.');
  if ($e['created_by'] === $user['id']) fail(403, 'Segregación de funciones: quien captura un egreso no puede aprobarlo.', 'SOD');
  if (!$aprobar) { $db->prepare("UPDATE egresos SET estado = 'rechazado', motivo = ?, aprobado_por = ?, aprobado_at = ? WHERE id = ?")->run($motivo ?: 'Rechazado', $user['id'], now_ms(), $e['id']); return ['estado' => 'rechazado']; }
  provisionarEgreso($db, $cid, $e, $user);
  return ['estado' => 'aprobado'];
}
function pagarEgreso(DB $db, int $cid, int $id, array $d, $user): array {
  $e = $db->prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?')->get($id, $cid) ?? fail(404, 'Egreso no encontrado');
  if ($e['estado'] !== 'aprobado') fail(409, $e['estado'] === 'por_aprobar' ? 'El egreso requiere aprobación antes de pagarse.' : 'El egreso no puede pagarse en su estado actual.');
  fechaOperable($d['fecha_pago'], 'La fecha de pago');
  $ctaPago = $d['metodo'] === 'efectivo' && empty($d['cuenta_banco_id']) ? cuenta($db, $cid, 'CAJA') : cuentaDeCobro($db, $cid, ['cuenta_banco_id' => $d['cuenta_banco_id'] ?? null, 'metodo' => $d['metodo']]);
  $pid = crearPoliza($db, $cid, ['tipo' => 'E', 'fecha' => fechaContable($db, $cid, $d['fecha_pago']), 'concepto' => "Pago E-{$e['folio']} · {$e['concepto']}" . (!empty($d['referencia']) ? ' · ref. ' . $d['referencia'] : ''), 'origen' => 'pago_egreso', 'origen_id' => $e['id'], 'lineas' => [
    ['cuenta' => cuenta($db, $cid, 'CXP'), 'debe' => $e['total_cents'], 'concepto' => $e['concepto']],
    ['cuenta' => $ctaPago, 'haber' => $e['total_cents'], 'concepto' => $e['concepto']],
  ]], $user);
  $db->prepare("UPDATE egresos SET estado = 'pagado', metodo_pago = ?, cuenta_banco_id = ?, referencia_pago = ?, fecha_pago = ?, pagado_por = ?, poliza_pago_id = ? WHERE id = ?")
    ->run($d['metodo'], $d['cuenta_banco_id'] ?? null, $d['referencia'] ?? null, $d['fecha_pago'], $user['id'], $pid, $e['id']);
  return ['poliza_id' => $pid];
}
function cancelarEgreso(DB $db, int $cid, int $id, string $motivo, $user): stdClass {
  $e = $db->prepare('SELECT * FROM egresos WHERE id = ? AND condominio_id = ?')->get($id, $cid) ?? fail(404, 'Egreso no encontrado');
  if (in_array($e['estado'], ['cancelado', 'rechazado'], true)) fail(409, 'El egreso ya está cancelado.');
  $fecha = fechaContable($db, $cid, hoy());
  foreach (array_filter([$e['poliza_pago_id'], $e['poliza_prov_id']]) as $pol) {
    $movs = $db->prepare('SELECT * FROM movimientos WHERE poliza_id = ?')->all($pol);
    $nid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => $fecha, 'concepto' => "Cancelación E-{$e['folio']} · {$motivo}", 'origen' => 'cancelacion_egreso', 'origen_id' => $e['id'], 'reversa_de' => $pol,
      'lineas' => array_map(fn($m) => ['cuenta' => $m['cuenta_id'], 'debe' => $m['haber_cents'], 'haber' => $m['debe_cents'], 'concepto' => $m['concepto']], $movs)], $user);
    $db->prepare('UPDATE polizas SET reversada_por = ? WHERE id = ? AND reversada_por IS NULL')->run($nid, $pol);
  }
  $db->prepare("UPDATE egresos SET estado = 'cancelado', motivo = ? WHERE id = ?")->run($motivo, $e['id']);
  $db->prepare("UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE conciliado_tipo = 'egreso' AND conciliado_id = ?")->run($e['id']);
  return new stdClass();
}

// ---------- Bancos y conciliación ----------
function crearCuentaBanco(DB $db, int $cid, array $d): int {
  $n = $db->prepare("SELECT COUNT(*) n FROM cuentas WHERE condominio_id = ? AND codigo LIKE '1102-%'")->get($cid)['n'] + 1;
  $k = $db->prepare('INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza) VALUES (?,?,?,?,?)')->run($cid, '1102-' . pad2($n), "Bancos · {$d['banco']} {$d['nombre']}", 'activo', 'D')['lastInsertRowid'];
  return $db->prepare('INSERT INTO cuentas_banco (condominio_id, nombre, banco, numero_mask, clabe_mask, cuenta_id, fondo) VALUES (?,?,?,?,?,?,?)')
    ->run($cid, $d['nombre'], $d['banco'], mask($d['numero'] ?? null), mask($d['clabe'] ?? null), $k, ($d['fondo'] ?? null) ?: 'operacion')['lastInsertRowid'];
}
function importarMovimientosBanco(DB $db, int $cid, int $bancoId, array $filas, $user): array {
  $b = $db->prepare('SELECT * FROM cuentas_banco WHERE id = ? AND condominio_id = ?')->get($bancoId, $cid) ?? fail(404, 'Cuenta bancaria no encontrada');
  $lote = 'IMP-' . token(6); $vistos = []; $nuevos = 0; $rep = 0;
  foreach ($filas as $f) {
    $base = implode('|', [$b['id'], $f['fecha'], $f['cargo_cents'], $f['abono_cents'], mb_strtoupper(trim((string)($f['descripcion'] ?? ''))), trim((string)($f['referencia'] ?? ''))]);
    $n = ($vistos[$base] ?? 0) + 1; $vistos[$base] = $n;
    $r = $db->prepare('INSERT OR IGNORE INTO banco_movs (cuenta_banco_id, fecha, descripcion, referencia, cargo_cents, abono_cents, huella, importacion) VALUES (?,?,?,?,?,?,?,?)')
      ->run($b['id'], $f['fecha'], ($f['descripcion'] ?? null) ?: null, ($f['referencia'] ?? null) ?: null, $f['cargo_cents'], $f['abono_cents'], sha256($base . '|' . $n), $lote);
    $r['changes'] ? $nuevos++ : $rep++;
  }
  return ['lote' => $lote, 'nuevos' => $nuevos, 'repetidos' => $rep, 'conciliados' => autoConciliar($db, $cid, $b['id'], $user)];
}
function autoConciliar(DB $db, int $cid, int $bancoId, $user): int {
  $movs = $db->prepare('SELECT * FROM banco_movs WHERE cuenta_banco_id = ? AND conciliado_tipo IS NULL ORDER BY fecha')->all($bancoId);
  $usado = fn($t, $id) => (bool)$db->prepare('SELECT 1 FROM banco_movs WHERE conciliado_tipo = ? AND conciliado_id = ?')->get($t, $id);
  $marcar = fn($t, $id, $mid) => $db->prepare('UPDATE banco_movs SET conciliado_tipo = ?, conciliado_id = ?, conciliado_por = ?, conciliado_at = ? WHERE id = ?')->run($t, $id, uid_($user), now_ms(), $mid);
  $n = 0;
  foreach ($movs as $m) {
    if ($m['abono_cents']) {
      $cands = filt($db->prepare("SELECT p.id, p.referencia, u.referencia AS uref FROM pagos p JOIN unidades u ON u.id = p.unidad_id WHERE p.condominio_id = ? AND p.cuenta_banco_id = ? AND p.estado = 'aplicado' AND p.monto_cents = ? AND ABS(julianday(p.fecha) - julianday(?)) <= 4")
        ->all($cid, $bancoId, $m['abono_cents'], $m['fecha']), fn($c) => !$usado('pago', $c['id']));
      $texto = mb_strtoupper(($m['descripcion'] ?? '') . ' ' . ($m['referencia'] ?? ''));
      $hit = find($cands, fn($c) => ($c['referencia'] && str_contains($texto, mb_strtoupper($c['referencia']))) || str_contains($texto, $c['uref'])) ?? (count($cands) === 1 ? $cands[0] : null);
      if ($hit) { $marcar('pago', $hit['id'], $m['id']); $n++; }
    } else {
      $cands = filt($db->prepare("SELECT id FROM egresos WHERE condominio_id = ? AND cuenta_banco_id = ? AND estado = 'pagado' AND total_cents = ? AND ABS(julianday(fecha_pago) - julianday(?)) <= 4")
        ->all($cid, $bancoId, $m['cargo_cents'], $m['fecha']), fn($c) => !$usado('egreso', $c['id']));
      if (count($cands) === 1) { $marcar('egreso', $cands[0]['id'], $m['id']); $n++; }
    }
  }
  return $n;
}
function conciliarManual(DB $db, int $cid, int $movId, ?string $tipo, $id, $user): void {
  $m = $db->prepare('SELECT bm.* FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE bm.id = ? AND b.condominio_id = ?')->get($movId, $cid) ?? fail(404, 'Movimiento no encontrado');
  if ($tipo === null) { $db->prepare('UPDATE banco_movs SET conciliado_tipo = NULL, conciliado_id = NULL, conciliado_por = NULL, conciliado_at = NULL WHERE id = ?')->run($m['id']); return; }
  if ($m['conciliado_tipo']) fail(409, 'El movimiento ya está conciliado.');
  if ($db->prepare('SELECT 1 FROM banco_movs WHERE conciliado_tipo = ? AND conciliado_id = ?')->get($tipo, $id)) fail(409, 'Ese documento ya está conciliado con otro movimiento.');
  if ($tipo === 'pago') {
    $p = $db->prepare("SELECT monto_cents FROM pagos WHERE id = ? AND condominio_id = ? AND estado = 'aplicado'")->get($id, $cid) ?? fail(404, 'Pago no encontrado');
    if ($p['monto_cents'] !== $m['abono_cents']) fail(400, 'El importe del pago no coincide con el depósito.');
  } elseif ($tipo === 'egreso') {
    $e = $db->prepare("SELECT total_cents FROM egresos WHERE id = ? AND condominio_id = ? AND estado = 'pagado'")->get($id, $cid) ?? fail(404, 'Egreso no encontrado');
    if ($e['total_cents'] !== $m['cargo_cents']) fail(400, 'El importe del egreso no coincide con el retiro.');
  } elseif ($tipo !== 'otro') fail(400, 'Tipo de conciliación inválido.');
  $db->prepare('UPDATE banco_movs SET conciliado_tipo = ?, conciliado_id = ?, conciliado_por = ?, conciliado_at = ? WHERE id = ?')->run($tipo, $id, $user['id'], now_ms(), $m['id']);
}

// ---------- Convenios ----------
function crearConvenio(DB $db, int $cid, array $d, $user): array {
  $u = unidadDe($db, $cid, $d['unidad_id']);
  if ($db->prepare("SELECT 1 FROM convenios WHERE unidad_id = ? AND estado = 'vigente'")->get($u['id'])) fail(409, 'La unidad ya tiene un convenio vigente.');
  if (!empty($d['condonar_recargos'])) foreach (filt(cargosAbiertos($db, $u['id']), fn($c) => $c['tipo'] === 'recargo') as $c) bonificar($db, $cid, $c['id'], $c['saldo_cents'], 'Condonación por convenio de pago', $user);
  $deuda = suma(filt(cargosAbiertos($db, $u['id']), fn($c) => $c['vencimiento'] < $d['fecha']), 'saldo_cents');
  if ($deuda <= 0) fail(400, 'La unidad no tiene saldo vencido para convenir.');
  $id = $db->prepare('INSERT INTO convenios (condominio_id, unidad_id, fecha, monto_cents, parcialidades, estado, suspende_recargos, notas, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    ->run($cid, $u['id'], $d['fecha'], $deuda, $d['parcialidades'], 'vigente', 1, $d['notas'] ?? null, $user['id'], now_ms())['lastInsertRowid'];
  $partes = prorratear($deuda, array_fill(0, $d['parcialidades'], 1));
  $dia = substr($d['fecha'], 8, 2) > '28' ? '28' : substr($d['fecha'], 8, 2);
  foreach ($partes as $i => $m) $db->prepare('INSERT INTO convenio_parcialidades (convenio_id, numero, vencimiento, monto_cents) VALUES (?,?,?,?)')->run($id, $i + 1, addMonths(periodoDe($d['fecha']), $i + 1) . "-{$dia}", $m);
  return ['id' => $id, 'monto_cents' => $deuda];
}
function estadoConvenio(DB $db, array $conv): array {
  $restante = $db->prepare('SELECT COALESCE(SUM(' . SALDO_CARGO . '), 0) s FROM cargos c WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND c.vencimiento < ?')->get($conv['unidad_id'], $conv['fecha'])['s'];
  $pagado = $conv['monto_cents'] - min($conv['monto_cents'], $restante);
  $exigible = $db->prepare('SELECT COALESCE(SUM(monto_cents), 0) s FROM convenio_parcialidades WHERE convenio_id = ? AND vencimiento <= ?')->get($conv['id'], hoy())['s'];
  return ['pagado' => $pagado, 'restante' => $conv['monto_cents'] - $pagado, 'exigible' => $exigible, 'al_corriente' => $pagado >= $exigible];
}

// ---------- Presupuesto ----------
function nuevaVersionPresupuesto(DB $db, int $cid, int $ejercicio, $user, ?int $copiarDe = null): int {
  if ($db->prepare("SELECT 1 FROM presupuestos WHERE condominio_id = ? AND ejercicio = ? AND estado = 'borrador'")->get($cid, $ejercicio)) fail(409, 'Ya existe un borrador para este ejercicio.');
  $version = $db->prepare('SELECT COALESCE(MAX(version), 0) + 1 v FROM presupuestos WHERE condominio_id = ? AND ejercicio = ?')->get($cid, $ejercicio)['v'];
  $id = $db->prepare("INSERT INTO presupuestos (condominio_id, ejercicio, version, estado, created_by, created_at) VALUES (?,?,?,'borrador',?,?)")->run($cid, $ejercicio, $version, $user['id'], now_ms())['lastInsertRowid'];
  $base = $copiarDe ?? ($db->prepare("SELECT id FROM presupuestos WHERE condominio_id = ? AND estado = 'aprobado' ORDER BY ejercicio DESC LIMIT 1")->get($cid)['id'] ?? null);
  if ($base) $db->prepare('INSERT INTO presupuesto_lineas (presupuesto_id, cuenta_id, mes, monto_cents) SELECT ?, cuenta_id, mes, monto_cents FROM presupuesto_lineas WHERE presupuesto_id = ?')->run($id, $base);
  return $id;
}
function guardarLineasPresupuesto(DB $db, int $cid, int $presId, array $lineas): void {
  $p = $db->prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?')->get($presId, $cid) ?? fail(404, 'Presupuesto no encontrado');
  if ($p['estado'] !== 'borrador') fail(409, 'Solo se edita un presupuesto en borrador.');
  foreach ($lineas as $l) {
    if (!is_array($l) || !$db->prepare("SELECT 1 FROM cuentas WHERE id = ? AND condominio_id = ? AND tipo IN ('egreso','ingreso')")->get($l['cuenta_id'] ?? null, $cid)
      || !is_int($l['mes'] ?? null) || $l['mes'] < 1 || $l['mes'] > 12 || !is_int($l['monto_cents'] ?? null) || $l['monto_cents'] < 0) fail(400, 'Línea de presupuesto inválida.');
    $db->prepare('INSERT INTO presupuesto_lineas (presupuesto_id, cuenta_id, mes, monto_cents) VALUES (?,?,?,?) ON CONFLICT (presupuesto_id, cuenta_id, mes) DO UPDATE SET monto_cents = excluded.monto_cents')->run($p['id'], $l['cuenta_id'], $l['mes'], $l['monto_cents']);
  }
}
function aprobarPresupuesto(DB $db, int $cid, int $presId, string $acta, $user): void {
  $p = $db->prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?')->get($presId, $cid) ?? fail(404, 'Presupuesto no encontrado');
  if ($p['estado'] !== 'borrador') fail(409, 'El presupuesto no está en borrador.');
  if (!$db->prepare('SELECT 1 FROM presupuesto_lineas WHERE presupuesto_id = ? AND monto_cents > 0')->get($p['id'])) fail(400, 'El presupuesto está vacío.');
  $db->prepare("UPDATE presupuestos SET estado = 'sustituido' WHERE condominio_id = ? AND ejercicio = ? AND estado = 'aprobado'")->run($cid, $p['ejercicio']);
  $db->prepare("UPDATE presupuestos SET estado = 'aprobado', acta = ?, aprobado_por = ?, aprobado_at = ? WHERE id = ?")->run($acta, $user['id'], now_ms(), $p['id']);
}
function cuotaSugerida(DB $db, int $cid, int $presId): array {
  $c = condo($db, $cid);
  $total = $db->prepare("SELECT COALESCE(SUM(l.monto_cents), 0) s FROM presupuesto_lineas l JOIN cuentas k ON k.id = l.cuenta_id WHERE l.presupuesto_id = ? AND k.tipo = 'egreso'")->get($presId)['s'];
  $mensualOper = jround($total / 12);
  $mensual = jround($mensualOper / (1 - $c['pct_reserva_bp'] / 10000));
  $unidades = $db->prepare('SELECT id, clave, indiviso_ppm, cuota_cents FROM unidades WHERE condominio_id = ? AND activo = 1 ORDER BY clave')->all($cid);
  $partes = $unidades ? prorratear($mensual, col($unidades, 'indiviso_ppm')) : [];
  return ['anual_egresos' => $total, 'mensual_requerido' => $mensual, 'unidades' => array_map(fn($u, $i) => $u + ['sugerida_cents' => (int)ceil($partes[$i] / 100) * 100], $unidades, array_keys($unidades))];
}

// ---------- Cierres ----------
function checklistCierre(DB $db, int $cid, string $periodo): array {
  $fin = "{$periodo}-31";
  return [
    'pagos_por_validar' => $db->prepare("SELECT COUNT(*) n FROM pagos WHERE condominio_id = ? AND estado = 'por_validar' AND fecha <= ?")->get($cid, $fin)['n'],
    'egresos_por_aprobar' => $db->prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar' AND fecha <= ?")->get($cid, $fin)['n'],
    'movs_sin_conciliar' => $db->prepare('SELECT COUNT(*) n FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE b.condominio_id = ? AND bm.conciliado_tipo IS NULL AND bm.fecha <= ?')->get($cid, $fin)['n'],
    'cuotas_emitidas' => $db->prepare("SELECT COUNT(*) n FROM cargos WHERE condominio_id = ? AND tipo = 'ordinaria' AND periodo = ?")->get($cid, $periodo)['n'],
    'anteriores_abiertos' => $db->prepare("SELECT COUNT(*) n FROM periodos WHERE condominio_id = ? AND periodo < ? AND estado = 'abierto'")->get($cid, $periodo)['n'],
  ];
}
function validarCierre(DB $db, int $cid, string $periodo): array {
  if ($periodo >= periodoDe(hoy())) fail(409, 'No se puede cerrar el periodo en curso.');
  if ($db->prepare("SELECT 1 FROM periodos WHERE condominio_id = ? AND periodo = ? AND estado = 'cerrado'")->get($cid, $periodo)) fail(409, 'El periodo ya está cerrado.');
  $ck = checklistCierre($db, $cid, $periodo);
  if ($ck['anteriores_abiertos']) fail(409, 'Cierre primero los periodos anteriores.');
  if ($ck['pagos_por_validar']) fail(409, "Hay {$ck['pagos_por_validar']} pagos reportados sin validar hasta este periodo.");
  if ($ck['egresos_por_aprobar']) fail(409, "Hay {$ck['egresos_por_aprobar']} egresos pendientes de aprobación hasta este periodo.");
  return $ck;
}
function cerrarPeriodo(DB $db, int $cid, string $periodo, $user): array {
  $ck = validarCierre($db, $cid, $periodo);
  $db->prepare("INSERT INTO periodos (condominio_id, periodo, estado, cerrado_por, cerrado_at) VALUES (?, ?, 'cerrado', ?, ?) ON CONFLICT (condominio_id, periodo) DO UPDATE SET estado = 'cerrado', cerrado_por = excluded.cerrado_por, cerrado_at = excluded.cerrado_at")
    ->run($cid, $periodo, uid_($user), now_ms());
  return $ck;
}
function ejercicioCerrado(DB $db, int $cid, int $anio): ?array { return $db->prepare("SELECT id FROM polizas WHERE condominio_id = ? AND origen = 'cierre_ejercicio' AND periodo = ? AND reversada_por IS NULL")->get($cid, "{$anio}-12"); }
function reabrirPeriodo(DB $db, int $cid, string $periodo): void {
  $ultimo = $db->prepare("SELECT MAX(periodo) p FROM periodos WHERE condominio_id = ? AND estado = 'cerrado'")->get($cid)['p'];
  if ($ultimo !== $periodo) fail(409, 'Solo puede reabrirse el último periodo cerrado.');
  if (ejercicioCerrado($db, $cid, (int)substr($periodo, 0, 4))) fail(409, 'El ejercicio ' . substr($periodo, 0, 4) . ' ya fue cerrado: reabra primero el ejercicio.');
  $db->prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('permitir_reapertura', '1')")->run();
  $db->prepare("UPDATE periodos SET estado = 'abierto' WHERE condominio_id = ? AND periodo = ?")->run($cid, $periodo);
  $db->prepare("DELETE FROM meta WHERE k = 'permitir_reapertura'")->run();
}
function cerrarEjercicio(DB $db, int $cid, int $anio, $user): int {
  if ($anio >= (int)substr(hoy(), 0, 4)) fail(409, 'El ejercicio aún no termina.');
  if (ejercicioCerrado($db, $cid, $anio)) fail(409, 'El ejercicio ya fue cerrado.');
  $ab = $db->prepare("SELECT COUNT(*) n FROM periodos WHERE condominio_id = ? AND periodo BETWEEN ? AND ? AND estado = 'abierto'")->get($cid, "{$anio}-01", "{$anio}-12")['n'];
  if ($ab) fail(409, "Cierre primero los {$ab} " . ($ab === 1 ? 'mes abierto' : 'meses abiertos') . " de {$anio}.");
  $saldos = $db->prepare("SELECT k.id, k.tipo, SUM(m.debe_cents) - SUM(m.haber_cents) AS neto FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND k.tipo IN ('ingreso','egreso') GROUP BY k.id HAVING neto <> 0")->all($cid, "{$anio}-01", "{$anio}-12");
  if (!$saldos) fail(400, 'No hay movimientos de resultados en el ejercicio.');
  $lineas = array_map(fn($s) => $s['neto'] > 0 ? ['cuenta' => $s['id'], 'haber' => $s['neto']] : ['cuenta' => $s['id'], 'debe' => -$s['neto']], $saldos);
  $neto = suma($saldos, 'neto');
  if ($neto !== 0) $lineas[] = $neto > 0 ? ['cuenta' => cuenta($db, $cid, 'REMANENTE'), 'debe' => $neto, 'concepto' => 'Déficit del ejercicio'] : ['cuenta' => cuenta($db, $cid, 'REMANENTE'), 'haber' => -$neto, 'concepto' => 'Remanente del ejercicio'];
  return crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => "{$anio}-12-31", 'concepto' => "Cierre del ejercicio {$anio}", 'origen' => 'cierre_ejercicio', 'lineas' => $lineas], $user);
}
function reabrirEjercicio(DB $db, int $cid, int $anio, string $motivo, $user): int {
  $c = ejercicioCerrado($db, $cid, $anio) ?? fail(409, 'El ejercicio no está cerrado.');
  if (ejercicioCerrado($db, $cid, $anio + 1)) fail(409, 'Reabra primero el ejercicio ' . ($anio + 1) . '.');
  $movs = $db->prepare('SELECT * FROM movimientos WHERE poliza_id = ?')->all($c['id']);
  $nid = crearPoliza($db, $cid, ['tipo' => 'D', 'fecha' => "{$anio}-12-31", 'concepto' => "Reapertura del ejercicio {$anio}: {$motivo}", 'origen' => 'reapertura_ejercicio', 'reversa_de' => $c['id'],
    'lineas' => array_map(fn($m) => ['cuenta' => $m['cuenta_id'], 'debe' => $m['haber_cents'], 'haber' => $m['debe_cents'], 'concepto' => $m['concepto']], $movs)], $user);
  $db->prepare('UPDATE polizas SET reversada_por = ? WHERE id = ?')->run($nid, $c['id']);
  return $nid;
}
