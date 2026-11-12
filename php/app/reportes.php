<?php
// Reportes financieros calculados desde el libro contable y el submayor de cargos (equivale a server/reportes.mjs).
declare(strict_types=1);

function plano($x): string { $s = (string)($x ?? ''); if (class_exists('Normalizer')) $s = preg_replace('/\p{Mn}/u', '', Normalizer::normalize($s, Normalizer::FORM_D) ?: $s); else $s = strtr($s, ['á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ü' => 'u', 'ñ' => 'n', 'Á' => 'A', 'É' => 'E', 'Í' => 'I', 'Ó' => 'O', 'Ú' => 'U', 'Ü' => 'U', 'Ñ' => 'N']); return mb_strtolower($s); }
function cmpEs($a, $b): int { return strcmp(plano($a), plano($b)) ?: strcmp((string)$a, (string)$b); }
function meses(string $d, string $h): array { $o = []; for ($p = $d; $p <= $h; $p = addMonths($p, 1)) $o[] = $p; return $o; }
function saldosCta(DB $db, int $cid, string $d, string $h, bool $sinCierre = true): array {
  return $db->prepare('SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, k.clave, COALESCE(SUM(m.debe_cents), 0) AS debe, COALESCE(SUM(m.haber_cents), 0) AS haber
    FROM cuentas k LEFT JOIN movimientos m ON m.cuenta_id = k.id AND m.poliza_id IN (SELECT id FROM polizas WHERE condominio_id = ? AND periodo BETWEEN ? AND ? ' . ($sinCierre ? "AND origen NOT IN ('cierre_ejercicio','reapertura_ejercicio')" : '') . ')
    WHERE k.condominio_id = ? GROUP BY k.id ORDER BY k.codigo')->all($cid, $d, $h, $cid);
}
function saldoNat(array $r): int { return $r['naturaleza'] === 'D' ? $r['debe'] - $r['haber'] : $r['haber'] - $r['debe']; }

function saldoBancos(DB $db, int $cid, string $hastaP = '9999-12'): array {
  $s = fn($k) => $db->prepare('SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?')->get($k, $hastaP)['s'];
  $bancos = array_map(fn($b) => $b + ['saldo_cents' => $s($b['cuenta_id'])], $db->prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id FROM cuentas_banco b WHERE b.condominio_id = ? AND b.activo = 1')->all($cid));
  $caja = $s(cuenta($db, $cid, 'CAJA'));
  return ['bancos' => $bancos, 'caja' => $caja, 'total' => suma($bancos, 'saldo_cents') + $caja];
}
function saldoCuentaClave(DB $db, int $cid, string $clave, string $hastaP = '9999-12'): int {
  $k = $db->prepare('SELECT * FROM cuentas WHERE condominio_id = ? AND clave = ?')->get($cid, $clave);
  $r = $db->prepare('SELECT COALESCE(SUM(m.debe_cents), 0) debe, COALESCE(SUM(m.haber_cents), 0) haber FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?')->get($k['id'], $hastaP);
  return saldoNat($r + $k);
}

// ---------- Cartera ----------
const APLICADO_AL = 'COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a JOIN polizas ap ON ap.id = a.poliza_id LEFT JOIN pagos pg ON pg.id = a.pago_id LEFT JOIN polizas cpg ON cpg.id = pg.cancel_poliza_id
  WHERE a.cargo_id = c.id AND ap.fecha <= ? AND (a.revertida = 0 OR cpg.fecha > ?)), 0)';
function cargosAlCorte(DB $db, int $cid, string $corte): array {
  return filt($db->prepare('SELECT c.id, c.unidad_id, c.tipo, c.concepto, c.periodo, c.vencimiento, c.monto_cents, c.monto_cents - ' . APLICADO_AL . ' AS saldo
    FROM cargos c LEFT JOIN polizas xp ON xp.id = c.cancel_poliza_id WHERE c.condominio_id = ? AND c.fecha <= ? AND (c.cancelado_at IS NULL OR xp.fecha > ?) ORDER BY c.vencimiento, c.id')->all($corte, $corte, $cid, $corte, $corte), fn($c) => $c['saldo'] > 0);
}
function carteraUnidades(DB $db, int $cid, ?string $corte = null): array {
  $corte ??= hoy();
  $unidades = $db->prepare("SELECT u.*, (SELECT GROUP_CONCAT(p.nombre, ', ') FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario') AS propietario,
      (SELECT p.email FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id ORDER BY up.rol = 'responsable' DESC, up.rol = 'propietario' DESC LIMIT 1) AS email,
      (SELECT p.telefono FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id ORDER BY up.rol = 'responsable' DESC, up.rol = 'propietario' DESC LIMIT 1) AS telefono,
      (SELECT MAX(fecha) FROM pagos WHERE unidad_id = u.id AND estado = 'aplicado' AND idem_key NOT LIKE 'INI-%' AND fecha <= ?) AS ultimo_pago
    FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave")->all($corte, $cid);
  $abiertos = cargosAlCorte($db, $cid, $corte);
  $fav = [];
  foreach ($db->prepare("SELECT p.unidad_id, SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a JOIN polizas ap ON ap.id = a.poliza_id JOIN cargos cg ON cg.id = a.cargo_id
        WHERE a.pago_id = p.id AND ap.fecha <= ? AND cg.fecha <= ? AND (a.revertida = 0 OR cp.fecha > ?)), 0)) AS s
    FROM pagos p JOIN polizas pp ON pp.id = p.poliza_id LEFT JOIN polizas cp ON cp.id = p.cancel_poliza_id
    WHERE p.condominio_id = ? AND p.estado IN ('aplicado','cancelado') AND pp.fecha <= ? AND (p.estado = 'aplicado' OR cp.fecha > ?) GROUP BY p.unidad_id")->all($corte, $corte, $corte, $cid, $corte, $corte) as $f) $fav[$f['unidad_id']] = $f['s'];
  $conv = []; foreach ($db->prepare("SELECT * FROM convenios WHERE condominio_id = ? AND estado = 'vigente'")->all($cid) as $c) $conv[$c['unidad_id']] = $c;
  $map = [];
  foreach ($unidades as $u) $map[$u['id']] = $u + ['por_vencer' => 0, 'd30' => 0, 'd60' => 0, 'd90' => 0, 'd90mas' => 0, 'vencido' => 0, 'adeudo' => 0, 'recargos' => 0, 'meses' => 0, 'saldo_favor' => $fav[$u['id']] ?? 0, 'convenio' => $conv[$u['id']] ?? null, 'dias_max' => 0];
  foreach ($abiertos as $c) {
    if (!isset($map[$c['unidad_id']])) continue;
    $u = &$map[$c['unidad_id']];
    $dias = diffDays($corte, $c['vencimiento']);
    $u['adeudo'] += $c['saldo'];
    if ($c['tipo'] === 'recargo') $u['recargos'] += $c['saldo'];
    if ($dias <= 0) $u['por_vencer'] += $c['saldo'];
    else {
      $u['vencido'] += $c['saldo']; $u['dias_max'] = max($u['dias_max'], $dias);
      if ($c['tipo'] === 'ordinaria') $u['meses']++;
      if ($dias <= 30) $u['d30'] += $c['saldo']; elseif ($dias <= 60) $u['d60'] += $c['saldo']; elseif ($dias <= 90) $u['d90'] += $c['saldo']; else $u['d90mas'] += $c['saldo'];
    }
    unset($u);
  }
  return array_map(fn($u) => array_merge($u, ['saldo_neto' => $u['adeudo'] - $u['saldo_favor'], 'convenio' => $u['convenio'] ? ['id' => $u['convenio']['id']] + estadoConvenio($db, $u['convenio']) : null]), array_values($map));
}
function carteraDetalle(DB $db, int $cid, ?string $corte = null): array {
  $corte ??= hoy();
  $clave = []; foreach ($db->prepare('SELECT id, clave FROM unidades WHERE condominio_id = ?')->all($cid) as $u) $clave[$u['id']] = $u['clave'];
  return array_map(fn($c) => ['unidad_id' => $c['unidad_id'], 'clave' => $clave[$c['unidad_id']] ?? null, 'tipo' => $c['tipo'], 'concepto' => $c['concepto'], 'periodo' => $c['periodo'], 'vencimiento' => $c['vencimiento'],
    'dias' => max(0, diffDays($corte, $c['vencimiento'])), 'monto_cents' => $c['monto_cents'], 'saldo_cents' => $c['saldo']], cargosAlCorte($db, $cid, $corte));
}
function tendenciaMorosidad(DB $db, int $cid, string $hastaP, int $n = 12): array {
  return array_map(function ($p) use ($db, $cid) {
    $corte = finDeMes($p) < hoy() ? finDeMes($p) : hoy();
    $r = resumenCartera(carteraUnidades($db, $cid, $corte));
    return ['periodo' => $p, 'corte' => $corte, 'vencido' => $r['vencido'], 'por_vencer' => $r['por_vencer'], 'morosas' => $r['morosas'], 'unidades' => $r['unidades'], 'pct_morosidad' => $r['pct_morosidad']];
  }, meses(addMonths($hastaP, -($n - 1)), $hastaP));
}
function resumenCartera(array $rows): array {
  $t = ['por_vencer' => 0, 'd30' => 0, 'd60' => 0, 'd90' => 0, 'd90mas' => 0, 'vencido' => 0, 'saldo_favor' => 0, 'morosas' => 0, 'unidades' => count(filt($rows, fn($r) => $r['activo']))];
  foreach ($rows as $r) { foreach (['por_vencer', 'd30', 'd60', 'd90', 'd90mas', 'vencido', 'saldo_favor'] as $k) $t[$k] += $r[$k]; if ($r['vencido'] > 0) $t['morosas']++; }
  $t['pct_morosidad'] = $t['unidades'] ? $t['morosas'] / $t['unidades'] : 0;
  return $t;
}

// ---------- Estado de cuenta ----------
const TIPO_CARGO = ['ordinaria' => 'cuota', 'extraordinaria' => 'extraordinaria', 'recargo' => 'recargo', 'multa' => 'multa', 'otro' => 'otro'];
function estadoCuenta(DB $db, int $cid, int $uid, string $desde, string $hasta): array {
  $cxc = cuenta($db, $cid, 'CXC'); $ant = cuenta($db, $cid, 'ANTICIPOS');
  $lineas = $db->prepare('SELECT m.cuenta_id, m.debe_cents, m.haber_cents, m.concepto, p.id AS poliza_id, p.fecha, p.tipo AS ptipo, p.folio AS pfolio, p.origen, p.origen_id
    FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.unidad_id = ? AND m.cuenta_id IN (?, ?) AND p.fecha <= ? ORDER BY p.fecha, p.id, m.id')->all($uid, $cxc, $ant, $hasta);
  $cargos = $db->prepare('SELECT c.id, c.tipo, c.concepto, c.monto_cents, c.poliza_id, c.cancelado_at, c.vencimiento, ' . SALDO_CARGO . " AS saldo,
    COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'pago'), 0) AS pagado FROM cargos c WHERE c.unidad_id = ?")->all($uid);
  $porPoliza = []; foreach ($cargos as $i => $c) $porPoliza[$c['poliza_id']][] = $i;
  $usado = [];
  $filas = []; $actual = -1;
  foreach ($lineas as $l) {
    if ($l['cuenta_id'] === $cxc && $l['debe_cents'] > 0 && isset($porPoliza[$l['poliza_id']])) {
      $lista = $porPoliza[$l['poliza_id']]; $sel = null;
      foreach ([fn($c) => $c['monto_cents'] === $l['debe_cents'] && $c['concepto'] === $l['concepto'], fn($c) => $c['monto_cents'] === $l['debe_cents'], fn($c) => true] as $crit) {
        foreach ($lista as $i) if (empty($usado[$i]) && $crit($cargos[$i])) { $sel = $i; break 2; }
      }
      if ($sel !== null) $usado[$sel] = true;
      $filas[] = $l + ['neto' => $l['debe_cents'], 'cargo' => $sel !== null ? $cargos[$sel] : null];
      $actual = -1; continue;
    }
    if ($actual < 0 || $filas[$actual]['poliza_id'] !== $l['poliza_id']) { $filas[] = $l + ['neto' => 0, 'cargo' => null]; $actual = count($filas) - 1; }
    $filas[$actual]['neto'] += $l['debe_cents'] - $l['haber_cents'];
  }
  $inicial = 0; $saldo = 0; $movs = [];
  foreach ($filas as $r) {
    if ($r['fecha'] < $desde) { $inicial += $r['neto']; continue; }
    if ($r['neto'] === 0) continue;
    if (!$movs) $saldo = $inicial;
    $saldo += $r['neto'];
    $mv = ['fecha' => $r['fecha'], 'poliza' => "{$r['ptipo']}-{$r['pfolio']}", 'origen' => $r['origen'], 'concepto' => $r['concepto'], 'cargo' => $r['neto'] > 0 ? $r['neto'] : 0, 'abono' => $r['neto'] < 0 ? -$r['neto'] : 0, 'saldo' => $saldo, 'recibo' => null, 'tipo' => $r['neto'] > 0 ? 'cargo' : 'abono', 'estatus' => null];
    if ($r['cargo']) {
      $c = $r['cargo'];
      $mv = array_merge($mv, ['tipo' => $r['origen'] === 'saldo_inicial' ? 'saldo_inicial' : TIPO_CARGO[$c['tipo']], 'concepto' => $c['concepto'], 'cargo_id' => $c['id'], 'vencimiento' => $c['vencimiento'], 'saldo_cargo' => max(0, $c['saldo']),
        'estatus' => $c['cancelado_at'] ? 'cancelada' : ($c['saldo'] <= 0 ? ($c['pagado'] ? 'pagada' : 'condonada') : ($c['saldo'] < $c['monto_cents'] ? 'parcial' : 'pendiente'))]);
    } elseif ($r['origen'] === 'pago') {
      $p = $db->prepare('SELECT id, folio, metodo, referencia, estado, poliza_id FROM pagos WHERE id = ?')->get($r['origen_id']);
      $apl = $p ? col($db->prepare("SELECT c.concepto FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.pago_id = ? AND a.tipo = 'pago' AND a.poliza_id = ? ORDER BY a.id")->all($p['id'], $p['poliza_id']), 'concepto') : [];
      $mv = array_merge($mv, ['tipo' => 'pago', 'pago_id' => $p['id'] ?? null, 'recibo' => $p['folio'] ?? null, 'metodo' => $p['metodo'] ?? null, 'referencia' => $p['referencia'] ?? null, 'estatus' => ($p['estado'] ?? null) === 'cancelado' ? 'cancelado' : 'aplicado',
        'concepto' => $apl ? implode(' · ', $apl) : 'Pago a cuenta (queda como saldo a favor)']);
    } elseif ($r['origen'] === 'bonificacion') {
      $b = $db->prepare('SELECT a.motivo, c.concepto FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE a.poliza_id = ? LIMIT 1')->get($r['poliza_id']);
      $mv = array_merge($mv, ['tipo' => 'descuento', 'concepto' => $b ? ($b['motivo'] === 'Descuento por pronto pago' ? 'Descuento por pronto pago' : "Bonificación · {$b['motivo']}") . ": {$b['concepto']}" : $r['concepto']]);
    } elseif ($r['origen'] === 'cancelacion_cargo') $mv['tipo'] = 'cancelacion';
    elseif ($r['origen'] === 'cancelacion_pago') $mv['tipo'] = 'cancelacion_pago';
    elseif ($r['origen'] === 'saldo_inicial') $mv = array_merge($mv, ['tipo' => 'saldo_inicial', 'concepto' => $r['concepto'] ?: 'Saldo a favor inicial']);
    $movs[] = $mv;
  }
  $cg = suma($movs, 'cargo'); $ab = suma($movs, 'abono');
  $sm = fn($f, $k) => suma(filt($movs, $f), $k);
  $totales = [
    'cuotas' => $sm(fn($m) => in_array($m['tipo'], ['cuota', 'extraordinaria', 'otro', 'saldo_inicial'], true), 'cargo'),
    'penalidades' => $sm(fn($m) => $m['tipo'] === 'recargo' || $m['tipo'] === 'multa', 'cargo'),
    'pagos' => $sm(fn($m) => $m['tipo'] === 'pago' || ($m['tipo'] === 'saldo_inicial' && $m['abono']), 'abono'),
    'descuentos' => $sm(fn($m) => $m['tipo'] === 'descuento' || $m['tipo'] === 'cancelacion', 'abono'),
    'otros_cargos' => $sm(fn($m) => $m['tipo'] === 'cancelacion_pago' || $m['tipo'] === 'cargo', 'cargo'),
  ];
  $pend = $db->prepare('SELECT c.id, c.tipo, c.concepto, c.periodo, c.vencimiento, c.monto_cents, ' . SALDO_CARGO . ' AS saldo_cents FROM cargos c WHERE c.unidad_id = ? AND c.cancelado_at IS NULL AND ' . SALDO_CARGO . ' > 0 ORDER BY c.vencimiento')->all($uid);
  $favor = $db->prepare("SELECT COALESCE(SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0)), 0) s FROM pagos p WHERE p.unidad_id = ? AND p.estado = 'aplicado'")->get($uid)['s'];
  return ['saldo_inicial' => $inicial, 'cargos' => $cg, 'abonos' => $ab, 'saldo_final' => $inicial + $cg - $ab, 'movimientos' => $movs, 'pendientes' => $pend, 'totales' => $totales, 'saldo_favor' => $favor];
}

// ---------- Estados financieros ----------
function estadoResultados(DB $db, int $cid, string $d, string $h): array {
  $ps = meses($d, $h);
  $rows = $db->prepare("SELECT k.id, k.codigo, k.nombre, k.tipo, k.naturaleza, p.periodo, SUM(m.debe_cents) d, SUM(m.haber_cents) h FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen NOT IN ('cierre_ejercicio','reapertura_ejercicio') AND k.tipo IN ('ingreso','egreso') GROUP BY k.id, p.periodo ORDER BY k.codigo")->all($cid, $d, $h);
  $cuentas = [];
  foreach ($rows as $r) {
    $cuentas[$r['id']] ??= ['id' => $r['id'], 'codigo' => $r['codigo'], 'nombre' => $r['nombre'], 'tipo' => $r['tipo'], 'meses' => array_fill_keys($ps, 0), 'total' => 0];
    $v = $r['tipo'] === 'ingreso' ? $r['h'] - $r['d'] : $r['d'] - $r['h'];
    $cuentas[$r['id']]['meses'][$r['periodo']] += $v; $cuentas[$r['id']]['total'] += $v;
  }
  $list = array_values($cuentas);
  $tot = function ($tipo) use ($ps, $list) { $o = []; foreach ($ps as $p) $o[$p] = suma(filt($list, fn($c) => $c['tipo'] === $tipo), fn($c) => $c['meses'][$p]); return $o; };
  $ing = $tot('ingreso'); $egr = $tot('egreso');
  $res = []; foreach ($ps as $p) $res[$p] = $ing[$p] - $egr[$p];
  return ['periodos' => $ps, 'ingresos' => filt($list, fn($c) => $c['tipo'] === 'ingreso'), 'egresos' => filt($list, fn($c) => $c['tipo'] === 'egreso'),
    'total_ingresos' => obj($ing), 'total_egresos' => obj($egr), 'resultado' => obj($res), 'totales' => ['ingresos' => array_sum($ing), 'egresos' => array_sum($egr), 'resultado' => array_sum($res)]];
}
function balanceGeneral(DB $db, int $cid, string $hastaP): array {
  $rows = array_map(fn($r) => $r + ['saldo' => saldoNat($r)], saldosCta($db, $cid, '0000-01', $hastaP, false));
  $grupo = fn($t) => filt($rows, fn($r) => $r['tipo'] === $t && $r['saldo'] !== 0);
  $res = suma(filt($rows, fn($r) => $r['tipo'] === 'ingreso' || $r['tipo'] === 'egreso'), fn($r) => $r['haber'] - $r['debe']);
  $a = $grupo('activo'); $p = $grupo('pasivo'); $pt = $grupo('patrimonio');
  $s = fn($l) => suma($l, 'saldo');
  return ['activo' => $a, 'pasivo' => $p, 'patrimonio' => $pt, 'resultado_acumulado' => $res, 'total_activo' => $s($a), 'total_pasivo' => $s($p), 'total_patrimonio' => $s($pt) + $res, 'cuadra' => $s($a) === $s($p) + $s($pt) + $res];
}
function balanza(DB $db, int $cid, string $d, string $h): array {
  $ini = []; foreach (saldosCta($db, $cid, '0000-01', addMonths($d, -1), false) as $r) $ini[$r['id']] = $r;
  $rows = filt(array_map(function ($r) use ($ini) {
    $si = saldoNat($ini[$r['id']]);
    return ['id' => $r['id'], 'codigo' => $r['codigo'], 'nombre' => $r['nombre'], 'tipo' => $r['tipo'], 'naturaleza' => $r['naturaleza'], 'inicial' => $si, 'debe' => $r['debe'], 'haber' => $r['haber'],
      'final' => $si + ($r['naturaleza'] === 'D' ? $r['debe'] - $r['haber'] : $r['haber'] - $r['debe'])];
  }, saldosCta($db, $cid, $d, $h, false)), fn($r) => $r['inicial'] || $r['debe'] || $r['haber']);
  $tot = ['debe' => suma($rows, 'debe'), 'haber' => suma($rows, 'haber')];
  return ['rows' => $rows, 'totales' => $tot, 'cuadra' => $tot['debe'] === $tot['haber']];
}
function libroMayor(DB $db, int $cid, int $cuentaId, string $d, string $h): ?array {
  $k = $db->prepare('SELECT * FROM cuentas WHERE id = ? AND condominio_id = ?')->get($cuentaId, $cid);
  if (!$k) return null;
  $ini = $db->prepare('SELECT COALESCE(SUM(m.debe_cents), 0) d, COALESCE(SUM(m.haber_cents), 0) h FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?')->get($k['id'], $d);
  $saldo = $k['naturaleza'] === 'D' ? $ini['d'] - $ini['h'] : $ini['h'] - $ini['d']; $inicial = $saldo;
  $movs = array_map(function ($m) use (&$saldo, $k) { $saldo += $k['naturaleza'] === 'D' ? $m['debe_cents'] - $m['haber_cents'] : $m['haber_cents'] - $m['debe_cents']; return $m + ['saldo' => $saldo]; },
    $db->prepare('SELECT p.id AS poliza_id, p.fecha, p.tipo, p.folio, p.concepto AS poliza_concepto, m.concepto, m.debe_cents, m.haber_cents, u.clave AS unidad FROM movimientos m JOIN polizas p ON p.id = m.poliza_id LEFT JOIN unidades u ON u.id = m.unidad_id
      WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ? ORDER BY p.fecha, p.id, m.id')->all($k['id'], $d, $h));
  return ['cuenta' => $k, 'inicial' => $inicial, 'final' => $saldo, 'movimientos' => $movs];
}
function presupuestoVsReal(DB $db, int $cid, int $ejercicio, ?int $presId = null): array {
  $pres = $presId ? $db->prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?')->get($presId, $cid)
    : $db->prepare("SELECT * FROM presupuestos WHERE condominio_id = ? AND ejercicio = ? ORDER BY estado = 'aprobado' DESC, version DESC LIMIT 1")->get($cid, $ejercicio);
  $lineas = $pres ? $db->prepare('SELECT cuenta_id, mes, monto_cents FROM presupuesto_lineas WHERE presupuesto_id = ?')->all($pres['id']) : [];
  $real = $db->prepare("SELECT m.cuenta_id, CAST(substr(p.periodo, 6, 2) AS INTEGER) AS mes, SUM(m.debe_cents - m.haber_cents) AS v FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND p.origen NOT IN ('cierre_ejercicio','reapertura_ejercicio') AND k.tipo = 'egreso' GROUP BY m.cuenta_id, mes")->all($cid, "{$ejercicio}-01", "{$ejercicio}-12");
  $cuentas = $db->prepare("SELECT id, codigo, nombre, COALESCE(tipo_gasto, 'variable') AS tipo_gasto FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo")->all($cid);
  $hy = hoy(); $mesActual = str_starts_with(periodoDe($hy), (string)$ejercicio) ? (int)substr($hy, 5, 2) : ($ejercicio < (int)substr($hy, 0, 4) ? 12 : 0);
  $rows = [];
  foreach ($cuentas as $k) {
    $p = array_fill(0, 12, 0); $r = array_fill(0, 12, 0);
    foreach ($lineas as $l) if ($l['cuenta_id'] === $k['id']) $p[$l['mes'] - 1] = $l['monto_cents'];
    foreach ($real as $x) if ($x['cuenta_id'] === $k['id']) $r[$x['mes'] - 1] = $x['v'];
    $anual = array_sum($p); $ej = array_sum($r); $alf = array_sum(array_slice($p, 0, $mesActual));
    if ($anual || $ej) $rows[] = $k + ['presupuesto' => $p, 'real' => $r, 'anual' => $anual, 'ejercido' => $ej, 'a_la_fecha' => $alf, 'variacion' => $alf - $ej, 'disponible' => $anual - $ej];
  }
  return ['presupuesto' => $pres ?: null, 'mes_actual' => $mesActual, 'rows' => $rows, 'totales' => ['anual' => suma($rows, 'anual'), 'ejercido' => suma($rows, 'ejercido'), 'a_la_fecha' => suma($rows, 'a_la_fecha'), 'disponible' => suma($rows, 'disponible')]];
}
function liquidacionEgresos(DB $db, int $cid, int $ej): array {
  $v = presupuestoVsReal($db, $cid, $ej);
  $sum = fn($rs, $k) => array_map(fn($i) => suma($rs, fn($r) => $r[$k][$i]), range(0, 11));
  $resumen = function ($rs) use ($sum) { $p = $sum($rs, 'presupuesto'); $r = $sum($rs, 'real'); $a = array_sum($p); $e = array_sum($r); return ['presupuesto' => $p, 'real' => $r, 'anual' => $a, 'ejercido' => $e, 'variacion' => $a - $e, 'a_la_fecha' => suma($rs, 'a_la_fecha')]; };
  $grupos = array_map(function ($t) use ($v, $resumen) { $rows = filt($v['rows'], fn($r) => $r['tipo_gasto'] === $t); return ['tipo' => $t, 'nombre' => $t === 'fijo' ? 'Gasto fijo' : 'Gasto variable', 'rows' => $rows] + $resumen($rows); }, ['fijo', 'variable']);
  return ['ejercicio' => $ej, 'presupuesto' => $v['presupuesto'], 'mes_actual' => $v['mes_actual'], 'cerrado' => $v['mes_actual'] === 12, 'grupos' => $grupos, 'totales' => $resumen($v['rows'])];
}
function flujoEfectivo(DB $db, int $cid, string $d, string $h): array {
  $ctas = [...col($db->prepare('SELECT cuenta_id FROM cuentas_banco WHERE condominio_id = ?')->all($cid), 'cuenta_id'), cuenta($db, $cid, 'CAJA')];
  $ph = implode(',', array_fill(0, count($ctas), '?'));
  $ini = $db->prepare("SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE p.condominio_id = ? AND p.periodo < ? AND m.cuenta_id IN ($ph)")->get($cid, $d, ...$ctas)['s'];
  $rows = $db->prepare("SELECT p.periodo, p.origen, SUM(m.debe_cents) e, SUM(m.haber_cents) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE p.condominio_id = ? AND p.periodo BETWEEN ? AND ? AND m.cuenta_id IN ($ph) GROUP BY p.periodo, p.origen")->all($cid, $d, $h, ...$ctas);
  $saldo = $ini; $ps = [];
  foreach (meses($d, $h) as $p) {
    $r = filt($rows, fn($x) => $x['periodo'] === $p);
    $en = suma($r, 'e'); $sa = suma($r, 's'); $i = $saldo; $saldo += $en - $sa;
    $ps[] = ['periodo' => $p, 'inicial' => $i, 'entradas' => $en, 'salidas' => $sa, 'final' => $saldo, 'cobranza' => suma(filt($r, fn($x) => $x['origen'] === 'pago'), 'e'), 'pagos_proveedores' => suma(filt($r, fn($x) => $x['origen'] === 'pago_egreso'), 's')];
  }
  return ['inicial' => $ini, 'final' => $saldo, 'periodos' => $ps];
}
function fondoReserva(DB $db, int $cid, string $d, string $h): array {
  $k = cuenta($db, $cid, 'FONDO_RESERVA');
  $ini = $db->prepare('SELECT COALESCE(SUM(m.haber_cents - m.debe_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?')->get($k, $d)['s'];
  $r = $db->prepare('SELECT COALESCE(SUM(m.haber_cents), 0) a, COALESCE(SUM(m.debe_cents), 0) u FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?')->get($k, $d, $h);
  $usos = $db->prepare("SELECT e.folio, e.fecha, e.concepto, e.total_cents, pr.nombre AS proveedor FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id
    WHERE e.condominio_id = ? AND e.fondo = 'reserva' AND e.fondo_id IS NULL AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 7) BETWEEN ? AND ? ORDER BY e.fecha")->all($cid, $d, $h);
  return ['inicial' => $ini, 'aportaciones' => $r['a'], 'aplicaciones' => $r['u'], 'final' => $ini + $r['a'] - $r['u'], 'usos' => $usos];
}
const PAGOS_PERIODO = "FROM pagos p JOIN polizas pol ON pol.id = p.poliza_id LEFT JOIN polizas cp ON cp.id = p.cancel_poliza_id WHERE p.condominio_id = ? AND p.idem_key NOT LIKE 'INI-%' AND p.estado IN ('aplicado','cancelado')";
function cobradoNeto(DB $db, int $cid, string $d, string $h): int {
  return $db->prepare("SELECT COALESCE(SUM(CASE WHEN pol.fecha BETWEEN ? AND ? THEN p.monto_cents ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN p.estado = 'cancelado' AND cp.fecha BETWEEN ? AND ? THEN p.monto_cents ELSE 0 END), 0) AS s " . PAGOS_PERIODO)->get($d, $h, $d, $h, $cid)['s'];
}
function cobranzaMensual(DB $db, int $cid, string $d, string $h): array {
  return array_map(function ($p) use ($db, $cid) {
    $em = $db->prepare("SELECT COALESCE(SUM(monto_cents), 0) s FROM cargos WHERE condominio_id = ? AND periodo = ? AND tipo IN ('ordinaria','extraordinaria') AND cancelado_at IS NULL")->get($cid, $p)['s'];
    $cb = $db->prepare("SELECT COALESCE(SUM(a.monto_cents), 0) s FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id WHERE c.condominio_id = ? AND c.periodo = ? AND c.tipo IN ('ordinaria','extraordinaria') AND c.cancelado_at IS NULL AND a.revertida = 0")->get($cid, $p)['s'];
    return ['periodo' => $p, 'emitido' => $em, 'cobrado' => $cb, 'recaudado' => cobradoNeto($db, $cid, "{$p}-01", finDeMes($p)), 'indice' => $em ? $cb / $em : null];
  }, meses($d, $h));
}

// ---------- Tablero ----------
function tablero(DB $db, int $cid, string $periodo): array {
  $c = condo($db, $cid);
  $cartera = carteraUnidades($db, $cid); $rc = resumenCartera($cartera);
  $desde = addMonths($periodo, -11);
  $er = estadoResultados($db, $cid, $desde, $periodo);
  $cob = cobranzaMensual($db, $cid, $desde, $periodo);
  $pvr = presupuestoVsReal($db, $cid, (int)substr($periodo, 0, 4));
  $mes = (int)substr($periodo, 5, 2);
  $presMes = suma($pvr['rows'], fn($r) => $r['presupuesto'][$mes - 1]);
  $cobMes = $cob[count($cob) - 1];
  $ti = (array)$er['total_ingresos']; $te = (array)$er['total_egresos'];
  $mor = filt($cartera, fn($u) => $u['vencido'] > 0); usort($mor, fn($a, $b) => $b['vencido'] <=> $a['vencido']);
  $ep = filt(array_map(fn($e) => ['nombre' => $e['nombre'], 'total' => $e['meses'][$periodo] ?? 0], $er['egresos']), fn($e) => $e['total'] > 0); usort($ep, fn($a, $b) => $b['total'] <=> $a['total']);
  return [
    'condominio' => ['id' => $c['id'], 'nombre' => $c['nombre']], 'periodo' => $periodo,
    'kpis' => ['emitido' => $cobMes['emitido'], 'cobrado' => $cobMes['cobrado'], 'recaudado' => $cobMes['recaudado'], 'indice_cobranza' => $cobMes['indice'],
      'cartera_vencida' => $rc['vencido'], 'unidades_morosas' => $rc['morosas'], 'unidades' => $rc['unidades'], 'pct_morosidad' => $rc['pct_morosidad'],
      'bancos' => saldoBancos($db, $cid), 'fondo_reserva' => saldoCuentaClave($db, $cid, 'FONDO_RESERVA'),
      'egresos_mes' => $te[$periodo] ?? 0, 'presupuesto_mes' => $presMes, 'ejercido_anual' => $pvr['totales']['ejercido'], 'presupuesto_anual' => $pvr['totales']['anual'], 'saldo_favor' => $rc['saldo_favor']],
    'serie' => array_map(fn($p, $i) => ['periodo' => $p, 'ingresos' => $ti[$p], 'egresos' => $te[$p], 'recaudado' => $cob[$i]['recaudado'], 'emitido' => $cob[$i]['emitido'], 'indice' => $cob[$i]['indice']], $er['periodos'], array_keys($er['periodos'])),
    'antiguedad' => ['por_vencer' => $rc['por_vencer'], 'd30' => $rc['d30'], 'd60' => $rc['d60'], 'd90' => $rc['d90'], 'd90mas' => $rc['d90mas']],
    'top_morosos' => array_map(fn($u) => ['id' => $u['id'], 'clave' => $u['clave'], 'propietario' => $u['propietario'], 'vencido' => $u['vencido'], 'meses' => $u['meses'], 'dias' => $u['dias_max'], 'convenio' => (bool)$u['convenio']], array_slice($mor, 0, 6)),
    'egresos_partida' => $ep,
    'pendientes' => [
      'pagos_por_validar' => $db->prepare("SELECT COUNT(*) n FROM pagos WHERE condominio_id = ? AND estado = 'por_validar'")->get($cid)['n'],
      'egresos_por_aprobar' => $db->prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar'")->get($cid)['n'],
      'egresos_por_pagar' => $db->prepare("SELECT COUNT(*) n FROM egresos WHERE condominio_id = ? AND estado = 'aprobado'")->get($cid)['n'],
      'movs_sin_conciliar' => $db->prepare('SELECT COUNT(*) n FROM banco_movs bm JOIN cuentas_banco b ON b.id = bm.cuenta_banco_id WHERE b.condominio_id = ? AND bm.conciliado_tipo IS NULL')->get($cid)['n'],
      'cuotas_mes_emitidas' => (bool)$db->prepare("SELECT 1 FROM cargos WHERE condominio_id = ? AND tipo = 'ordinaria' AND periodo = ? LIMIT 1")->get($cid, $periodo),
      'periodo_anterior_abierto' => (bool)$db->prepare("SELECT 1 FROM periodos WHERE condominio_id = ? AND periodo < ? AND estado = 'abierto' LIMIT 1")->get($cid, $periodo),
    ],
  ];
}
function informeAnual(DB $db, int $cid, int $anio): array {
  $c = condo($db, $cid); $d = "{$anio}-01"; $h = "{$anio}-12";
  $corte = finDeMes($h) < hoy() ? finDeMes($h) : hoy();
  $cartera = carteraUnidades($db, $cid, $corte);
  $cob = cobranzaMensual($db, $cid, $d, $h);
  $em = suma($cob, 'emitido'); $cb = suma($cob, 'cobrado');
  $mor = filt($cartera, fn($u) => $u['vencido'] > 0); usort($mor, fn($a, $b) => $b['vencido'] <=> $a['vencido']);
  return ['condominio' => $c, 'ejercicio' => $anio, 'corte' => $corte, 'resultados' => estadoResultados($db, $cid, $d, $h), 'presupuesto' => presupuestoVsReal($db, $cid, $anio), 'flujo' => flujoEfectivo($db, $cid, $d, $h),
    'fondo_reserva' => fondoReserva($db, $cid, $d, $h), 'balance' => balanceGeneral($db, $cid, $h), 'cobranza' => ['meses' => $cob, 'emitido' => $em, 'cobrado' => $cb, 'indice' => $em ? $cb / $em : null],
    'cartera' => ['resumen' => resumenCartera($cartera), 'morosos' => array_map(fn($u) => ['clave' => $u['clave'], 'propietario' => $u['propietario'], 'vencido' => $u['vencido'], 'meses' => $u['meses'], 'convenio' => (bool)$u['convenio']], $mor)],
    'cerrado' => (bool)$db->prepare("SELECT 1 FROM polizas WHERE condominio_id = ? AND origen = 'cierre_ejercicio' AND periodo = ? AND reversada_por IS NULL")->get($cid, $h)];
}
function verificarIntegridad(DB $db, int $cid): array {
  $desc = $db->prepare('SELECT p.id, p.tipo, p.folio FROM polizas p JOIN movimientos m ON m.poliza_id = p.id WHERE p.condominio_id = ? GROUP BY p.id HAVING SUM(m.debe_cents) <> SUM(m.haber_cents) OR SUM(m.debe_cents) <> p.total_cents')->all($cid);
  $cxc = cuenta($db, $cid, 'CXC'); $ant = cuenta($db, $cid, 'ANTICIPOS');
  $lc = $db->prepare('SELECT COALESCE(SUM(debe_cents - haber_cents), 0) s FROM movimientos WHERE cuenta_id = ?')->get($cxc)['s'];
  $sc = $db->prepare('SELECT COALESCE(SUM(' . SALDO_CARGO . '), 0) s FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL')->get($cid)['s'];
  $la = $db->prepare('SELECT COALESCE(SUM(haber_cents - debe_cents), 0) s FROM movimientos WHERE cuenta_id = ?')->get($ant)['s'];
  $sa = $db->prepare("SELECT COALESCE(SUM(p.monto_cents - COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.pago_id = p.id AND a.revertida = 0), 0)), 0) s FROM pagos p WHERE p.condominio_id = ? AND p.estado = 'aplicado'")->get($cid)['s'];
  $bal = balanceGeneral($db, $cid, '9999-12');
  return ['polizas_descuadradas' => $desc, 'balance_cuadra' => $bal['cuadra'], 'cxc' => ['libro' => $lc, 'submayor' => $sc, 'cuadra' => $lc === $sc], 'anticipos' => ['libro' => $la, 'submayor' => $sa, 'cuadra' => $la === $sa],
    'ok' => !$desc && $bal['cuadra'] && $lc === $sc && $la === $sa];
}
function fondos(DB $db, int $cid, string $d, string $h): array {
  $res = cuenta($db, $cid, 'FONDO_RESERVA');
  $lista = [['id' => null, 'nombre' => 'Fondo de reserva', 'cuenta_id' => $res, 'meta_cents' => null, 'descripcion' => 'Aportación mensual de las cuotas ordinarias', 'sistema' => true],
    ...$db->prepare('SELECT id, nombre, cuenta_id, meta_cents, descripcion, activo FROM fondos WHERE condominio_id = ? ORDER BY nombre')->all($cid)];
  $rows = array_map(function ($f) use ($db, $cid, $d, $h) {
    $i = $db->prepare('SELECT COALESCE(SUM(m.haber_cents - m.debe_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo < ?')->get($f['cuenta_id'], $d)['s'];
    $m = $db->prepare('SELECT COALESCE(SUM(m.haber_cents), 0) a, COALESCE(SUM(m.debe_cents), 0) u FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?')->get($f['cuenta_id'], $d, $h);
    $saldo = $i + $m['a'] - $m['u'];
    $usos = $db->prepare("SELECT e.folio, e.fecha, e.concepto, e.total_cents, e.estado, pr.nombre AS proveedor FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id
      WHERE e.condominio_id = ? AND e.fondo = 'reserva' AND e.fondo_id IS ? AND e.estado IN ('aprobado','pagado') AND substr(e.fecha, 1, 7) BETWEEN ? AND ? ORDER BY e.fecha DESC")->all($cid, $f['id'], $d, $h);
    return $f + ['inicial' => $i, 'aportaciones' => $m['a'], 'aplicaciones' => $m['u'], 'saldo' => $saldo, 'avance' => $f['meta_cents'] ? $saldo / $f['meta_cents'] : null, 'usos' => $usos];
  }, $lista);
  return ['desde' => $d, 'hasta' => $h, 'fondos' => $rows, 'total' => suma($rows, 'saldo')];
}
function cuentasPorPagar(DB $db, int $cid, ?string $corte = null): array {
  $corte ??= hoy();
  $rows = $db->prepare("SELECT e.id, e.folio, e.fecha, e.concepto, e.total_cents, e.factura_folio, e.fondo, pr.id AS proveedor_id, pr.nombre AS proveedor, k.codigo AS partida_codigo, k.nombre AS partida
    FROM egresos e LEFT JOIN proveedores pr ON pr.id = e.proveedor_id JOIN cuentas k ON k.id = e.cuenta_id WHERE e.condominio_id = ? AND e.estado = 'aprobado' ORDER BY e.fecha")->all($cid);
  $t = ['d30' => 0, 'd60' => 0, 'd90' => 0, 'd90mas' => 0, 'total' => 0]; $prov = [];
  foreach ($rows as &$r) {
    $r['dias'] = max(0, diffDays($corte, $r['fecha'])); $r['banda'] = $r['dias'] <= 30 ? 'd30' : ($r['dias'] <= 60 ? 'd60' : ($r['dias'] <= 90 ? 'd90' : 'd90mas'));
    $t[$r['banda']] += $r['total_cents']; $t['total'] += $r['total_cents'];
    $k = $r['proveedor_id'] ?: 0;
    $prov[$k] ??= ['proveedor' => $r['proveedor'] ?: 'Sin proveedor', 'd30' => 0, 'd60' => 0, 'd90' => 0, 'd90mas' => 0, 'total' => 0, 'documentos' => 0];
    $prov[$k][$r['banda']] += $r['total_cents']; $prov[$k]['total'] += $r['total_cents']; $prov[$k]['documentos']++;
  }
  unset($r);
  $pa = $db->prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents), 0) s FROM egresos WHERE condominio_id = ? AND estado = 'por_aprobar'")->get($cid);
  $pv = array_values($prov); usort($pv, fn($a, $b) => $b['total'] <=> $a['total']);
  return ['corte' => $corte, 'totales' => $t, 'por_aprobar' => $pa, 'proveedores' => $pv, 'documentos' => $rows];
}
function liquidacionAnual(DB $db, int $cid, int $anio): array {
  $ps = meses("{$anio}-01", "{$anio}-12");
  $unidades = $db->prepare("SELECT u.id, u.clave, u.torre, u.cuota_cents, u.activo, (SELECT GROUP_CONCAT(p.nombre, ', ') FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario') AS propietario
    FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave")->all($cid);
  $cargos = $db->prepare("SELECT c.unidad_id, c.periodo, SUM(c.monto_cents) emitido, SUM(COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'pago'), 0)) pagado,
      SUM(COALESCE((SELECT SUM(a.monto_cents) FROM aplicaciones a WHERE a.cargo_id = c.id AND a.revertida = 0 AND a.tipo = 'bonificacion'), 0)) bonificado
    FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.periodo BETWEEN ? AND ? GROUP BY c.unidad_id, c.periodo")->all($cid, $ps[0], $ps[11]);
  $prev = []; foreach ($db->prepare('SELECT c.unidad_id, SUM(' . SALDO_CARGO . ') s FROM cargos c WHERE c.condominio_id = ? AND c.cancelado_at IS NULL AND c.periodo < ? GROUP BY c.unidad_id')->all($cid, $ps[0]) as $r) $prev[$r['unidad_id']] = $r['s'];
  $map = []; foreach ($unidades as $u) $map[$u['id']] = $u + ['adeudo_previo' => $prev[$u['id']] ?? 0, 'meses' => array_fill_keys($ps, null), 'emitido' => 0, 'pagado' => 0, 'bonificado' => 0];
  foreach ($cargos as $c) {
    if (!isset($map[$c['unidad_id']])) continue;
    $u = &$map[$c['unidad_id']];
    $s = $c['emitido'] - $c['pagado'] - $c['bonificado'];
    $u['meses'][$c['periodo']] = ['emitido' => $c['emitido'], 'pagado' => $c['pagado'], 'bonificado' => $c['bonificado'], 'saldo' => $s, 'estado' => $s <= 0 ? 'pagado' : ($c['pagado'] + $c['bonificado'] > 0 ? 'parcial' : 'pendiente')];
    $u['emitido'] += $c['emitido']; $u['pagado'] += $c['pagado']; $u['bonificado'] += $c['bonificado'];
    unset($u);
  }
  $rows = array_map(fn($u) => $u + ['saldo' => $u['emitido'] - $u['pagado'] - $u['bonificado']], array_values($map));
  $tot = ['emitido' => 0, 'pagado' => 0, 'bonificado' => 0, 'saldo' => 0, 'adeudo_previo' => 0, 'meses' => array_fill_keys($ps, ['emitido' => 0, 'pagado' => 0])];
  foreach ($rows as $u) {
    foreach (['emitido', 'pagado', 'bonificado', 'saldo', 'adeudo_previo'] as $k) $tot[$k] += $u[$k];
    foreach ($ps as $p) if ($u['meses'][$p]) { $tot['meses'][$p]['emitido'] += $u['meses'][$p]['emitido']; $tot['meses'][$p]['pagado'] += $u['meses'][$p]['pagado']; }
  }
  return ['ejercicio' => $anio, 'periodos' => $ps, 'unidades' => $rows, 'totales' => $tot];
}
function descuentos(DB $db, int $cid, string $d, string $h): array {
  $rows = $db->prepare("SELECT a.id, a.monto_cents, a.motivo, a.revertida, a.created_at, p.fecha, c.concepto, c.periodo, c.tipo, u.id AS unidad_id, u.clave, us.nombre AS autor
    FROM aplicaciones a JOIN cargos c ON c.id = a.cargo_id JOIN unidades u ON u.id = c.unidad_id LEFT JOIN polizas p ON p.id = a.poliza_id LEFT JOIN usuarios us ON us.id = a.created_by
    WHERE a.condominio_id = ? AND a.tipo = 'bonificacion' AND p.fecha BETWEEN ? AND ? ORDER BY p.fecha DESC, a.id DESC LIMIT 2000")->all($cid, $d, $h);
  $vig = filt($rows, fn($r) => !$r['revertida']); $pm = [];
  foreach ($vig as $r) { $k = preg_match('/pronto pago/i', (string)$r['motivo']) ? 'Pronto pago' : (preg_match('/convenio/i', (string)$r['motivo']) ? 'Convenios' : 'Otras bonificaciones'); $pm[$k] = ($pm[$k] ?? 0) + $r['monto_cents']; }
  return ['desde' => $d, 'hasta' => $h, 'total' => suma($vig, 'monto_cents'), 'por_tipo' => array_map(fn($k, $v) => ['tipo' => $k, 'monto' => $v], array_keys($pm), array_values($pm)), 'movimientos' => $rows];
}

// ---------- Ingresos y egresos agrupados ----------
final class Agrupador {
  public array $g = [];
  public function __construct(array $nombres) { foreach ($nombres as [$k, $n]) $this->g[$k] = ['clave' => $k, 'nombre' => $n, 'total' => 0, 'clasif' => []]; }
  public function add(string $grupo, string $clasif, $concepto, int $monto, ?array $extra = null): void {
    $G = &$this->g[$grupo]; $G['total'] += $monto;
    $G['clasif'][$clasif] ??= ['nombre' => $clasif, 'total' => 0, 'conceptos' => []];
    $C = &$G['clasif'][$clasif]; $C['total'] += $monto;
    $k = $extra ? "{$concepto}\0" . count($C['conceptos']) : (string)$concepto;
    $C['conceptos'][$k] ??= ['concepto' => $concepto, 'total' => 0] + ($extra ?? []);
    $C['conceptos'][$k]['total'] += $monto;
  }
  public function salida(): array {
    return array_map(function ($G) { $cl = array_values($G['clasif']); usort($cl, fn($a, $b) => cmpEs($a['nombre'], $b['nombre']));
      return ['clave' => $G['clave'], 'nombre' => $G['nombre'], 'total' => $G['total'], 'clasificaciones' => array_map(fn($C) => ['nombre' => $C['nombre'], 'total' => $C['total'], 'conceptos' => array_values($C['conceptos'])], $cl)]; }, array_values($this->g));
  }
}
function clasifDe(array $grupos): array|stdClass { $o = []; foreach ($grupos as $g) foreach ($g['clasificaciones'] as $c) $o["{$g['clave']}|{$c['nombre']}"] = $c['total']; return obj($o); }
const METODO_NOMBRE = ['transferencia' => 'Transferencia', 'deposito' => 'Depósito', 'efectivo' => 'Efectivo', 'tarjeta' => 'Tarjeta', 'cheque' => 'Cheque', 'domiciliacion' => 'Domiciliación'];
function periodoAnterior(string $d, string $h): array {
  if (str_ends_with($d, '-01') && $h === finDeMes(substr($h, 0, 7))) {
    $n = ((int)substr($h, 0, 4) - (int)substr($d, 0, 4)) * 12 + ((int)substr($h, 5, 2) - (int)substr($d, 5, 2)) + 1;
    return ['desde' => addMonths(substr($d, 0, 7), -$n) . '-01', 'hasta' => finDeMes(addMonths(substr($h, 0, 7), -$n))];
  }
  $dias = diffDays($h, $d) + 1;
  return ['desde' => addDays($d, -$dias), 'hasta' => addDays($d, -1)];
}
function acumular(array &$map, $k, array $base, int $monto): void { $map[$k] ??= $base + ['n' => 0, 'monto' => 0]; $map[$k]['n']++; $map[$k]['monto'] += $monto; }
function ordenMonto(array $m): array { $v = array_values($m); usort($v, fn($x, $y) => $y['monto'] <=> $x['monto']); return $v; }

function ingresos(DB $db, int $cid, string $desde, string $hasta, bool $detalle = true): array {
  $pagos = $db->prepare("SELECT p.id, p.folio, p.fecha, p.monto_cents, p.estado, p.metodo, p.referencia, p.unidad_id, pol.fecha AS f, cp.fecha AS fc, u.clave, b.banco, b.nombre AS cuenta,
      (SELECT GROUP_CONCAT(pe.nombre, ', ') FROM unidad_personas up JOIN personas pe ON pe.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = 'propietario') AS propietario "
    . str_replace('WHERE', 'JOIN unidades u ON u.id = p.unidad_id LEFT JOIN cuentas_banco b ON b.id = p.cuenta_banco_id WHERE', PAGOS_PERIODO) . ' AND ((pol.fecha BETWEEN ? AND ?) OR (cp.fecha BETWEEN ? AND ?)) ORDER BY pol.fecha, p.folio')->all($cid, $desde, $hasta, $desde, $hasta);
  $dentro = fn($f) => $f !== null && $f >= $desde && $f <= $hasta;
  $signo = []; foreach ($pagos as $p) $signo[$p['id']] = ($dentro($p['f']) ? 1 : 0) - ($p['estado'] === 'cancelado' && $dentro($p['fc']) ? 1 : 0);
  $apl = $db->prepare("SELECT a.pago_id, c.tipo, c.concepto, k.codigo, k.nombre, SUM(a.monto_cents) monto
    FROM aplicaciones a JOIN pagos p ON p.id = a.pago_id JOIN polizas pol ON pol.id = p.poliza_id LEFT JOIN polizas cp ON cp.id = p.cancel_poliza_id JOIN cargos c ON c.id = a.cargo_id JOIN cuentas k ON k.id = c.cuenta_ingreso_id
    WHERE p.condominio_id = ? AND p.idem_key NOT LIKE 'INI-%' AND a.tipo = 'pago' AND ((p.estado = 'aplicado' AND a.revertida = 0) OR (p.estado = 'cancelado' AND a.revertida = 1))
      AND ((pol.fecha BETWEEN ? AND ?) OR (cp.fecha BETWEEN ? AND ?)) GROUP BY a.pago_id, c.id ORDER BY k.codigo, c.periodo, c.concepto")->all($cid, $desde, $hasta, $desde, $hasta);
  $otros = $db->prepare("SELECT k.codigo, k.nombre, p.concepto, SUM(m.haber_cents - m.debe_cents) monto FROM movimientos m JOIN polizas p ON p.id = m.poliza_id JOIN cuentas k ON k.id = m.cuenta_id
    WHERE p.condominio_id = ? AND p.origen IN ('manual','reverso') AND p.fecha BETWEEN ? AND ? AND k.tipo = 'ingreso' AND k.clave IS NOT 'BONIF'
      AND EXISTS (SELECT 1 FROM movimientos m2 JOIN cuentas k2 ON k2.id = m2.cuenta_id WHERE m2.poliza_id = p.id AND (k2.clave = 'CAJA' OR k2.id IN (SELECT cuenta_id FROM cuentas_banco WHERE condominio_id = p.condominio_id)))
    GROUP BY k.id, p.concepto HAVING monto <> 0")->all($cid, $desde, $hasta);
  $A = new Agrupador([['pendientes', 'Ingresos pendientes de aplicar'], ['ordinarios', 'Ingresos ordinarios'], ['extraordinarios', 'Ingresos extraordinarios'], ['otros', 'Otros ingresos']]);
  $aplicadoDe = [];
  foreach ($apl as $a) {
    $sg = $signo[$a['pago_id']] ?? 0; if (!$sg) continue;
    $aplicadoDe[$a['pago_id']] = ($aplicadoDe[$a['pago_id']] ?? 0) + $a['monto'];
    $A->add($a['tipo'] === 'extraordinaria' ? 'extraordinarios' : 'ordinarios', "{$a['codigo']} · {$a['nombre']}", $a['concepto'], $a['monto'] * $sg);
  }
  $cobrado = 0; $recibidos = 0; $pendiente = 0; $cancel = ['n' => 0, 'monto' => 0]; $met = []; $cts = []; $uns = [];
  foreach ($pagos as $p) {
    $sg = $signo[$p['id']];
    if ($dentro($p['f'])) $recibidos++;
    if ($p['estado'] === 'cancelado' && $dentro($p['fc'])) { $cancel['n']++; $cancel['monto'] += $p['monto_cents']; }
    if (!$sg) continue;
    $cobrado += $p['monto_cents'] * $sg;
    $pendiente += ($p['monto_cents'] - ($aplicadoDe[$p['id']] ?? 0)) * $sg;
    acumular($met, $p['metodo'], ['metodo' => METODO_NOMBRE[$p['metodo']] ?? $p['metodo']], $p['monto_cents'] * $sg);
    $cn = $p['cuenta'] ? "{$p['banco']} · {$p['cuenta']}" : 'Caja (efectivo)';
    acumular($cts, $cn, ['cuenta' => $cn], $p['monto_cents'] * $sg);
    acumular($uns, 'u' . $p['unidad_id'], ['unidad_id' => $p['unidad_id'], 'clave' => $p['clave'], 'propietario' => $p['propietario']], $p['monto_cents'] * $sg);
  }
  if ($pendiente) $A->add('pendientes', 'Saldos a favor y anticipos', 'Pagos recibidos que aún no cubren ninguna cuota', $pendiente);
  foreach ($otros as $o) $A->add('otros', "{$o['codigo']} · {$o['nombre']}", $o['concepto'], $o['monto']);
  $grupos = $A->salida(); $total = suma($grupos, 'total');
  $ant = periodoAnterior($desde, $hasta);
  $corto = diffDays($hasta, $desde) <= 62;
  return ['desde' => $desde, 'hasta' => $hasta, 'pagos' => $recibidos, 'cobrado' => $cobrado, 'total' => $total, 'grupos' => $grupos, 'cancelados' => $cancel, 'por_metodo' => ordenMonto($met), 'por_cuenta' => ordenMonto($cts), 'por_unidad' => ordenMonto($uns),
    'anterior' => $detalle ? $ant + ['total' => ingresos($db, $cid, $ant['desde'], $ant['hasta'], false)['total']] : null,
    'recibos' => $detalle && $corto ? array_map(fn($p) => ['folio' => $p['folio'], 'fecha' => $p['f'], 'fecha_pago' => $p['fecha'], 'unidad_id' => $p['unidad_id'], 'clave' => $p['clave'], 'propietario' => $p['propietario'], 'metodo' => METODO_NOMBRE[$p['metodo']] ?? $p['metodo'],
      'cuenta' => $p['cuenta'] ? "{$p['banco']} · {$p['cuenta']}" : 'Caja', 'referencia' => $p['referencia'], 'monto' => $p['monto_cents'] * $signo[$p['id']], 'cancelado' => $signo[$p['id']] < 0], filt($pagos, fn($p) => $signo[$p['id']])) : null];
}
function ingresosMensual(DB $db, int $cid, int $anio): array {
  $cob = []; foreach (cobranzaMensual($db, $cid, "{$anio}-01", "{$anio}-12") as $x) $cob[$x['periodo']] = $x;
  return ['anio' => $anio, 'meses' => array_map(function ($p) use ($db, $cid, $cob) {
    $r = ingresos($db, $cid, "{$p}-01", finDeMes($p), false);
    $g = []; foreach ($r['grupos'] as $x) $g[$x['clave']] = $x['total'];
    $c = $cob[$p];
    return ['periodo' => $p] + $g + ['total' => $r['total'], 'pagos' => $r['pagos'], 'emitido' => $c['emitido'], 'cobrado_del_mes' => $c['cobrado'], 'indice' => $c['indice'], 'clasificaciones' => clasifDe($r['grupos'])];
  }, meses("{$anio}-01", "{$anio}-12"))];
}
function egresosReporte(DB $db, int $cid, string $desde, string $hasta, bool $detalle = true): array {
  $rows = $db->prepare("SELECT e.id, e.folio, e.fecha, e.concepto, e.total_cents, e.fondo, e.estado, e.metodo_pago, e.fecha_pago, e.factura_folio, k.id AS cuenta_id, k.codigo, k.nombre AS partida, pr.nombre AS proveedor,
      f.nombre AS fondo_nombre, pp.fecha AS f, b.banco, b.nombre AS cuenta, (SELECT MIN(x.fecha) FROM polizas x WHERE x.reversa_de = e.poliza_prov_id AND x.origen = 'cancelacion_egreso') AS fc
    FROM egresos e JOIN polizas pp ON pp.id = e.poliza_prov_id JOIN cuentas k ON k.id = e.cuenta_id LEFT JOIN proveedores pr ON pr.id = e.proveedor_id LEFT JOIN fondos f ON f.id = e.fondo_id LEFT JOIN cuentas_banco b ON b.id = e.cuenta_banco_id
    WHERE e.condominio_id = ? AND ((e.estado IN ('aprobado','pagado') AND pp.fecha BETWEEN ? AND ?) OR e.estado = 'cancelado') ORDER BY k.codigo, pp.fecha, e.folio")->all($cid, $desde, $hasta);
  $dentro = fn($f) => $f !== null && $f >= $desde && $f <= $hasta;
  $A = new Agrupador([['ordinarios', 'Egresos ordinarios'], ['extraordinarios', 'Egresos extraordinarios']]);
  $docs = 0; $pagado = 0; $porPagar = 0; $ajuste = 0; $cancel = ['n' => 0, 'monto' => 0]; $prov = []; $met = []; $cts = [];
  foreach ($rows as $e) {
    $sg = ($dentro($e['f']) ? 1 : 0) - ($e['estado'] === 'cancelado' && $dentro($e['fc']) ? 1 : 0);
    if ($e['estado'] === 'cancelado' && $dentro($e['fc'])) { $cancel['n']++; $cancel['monto'] += $e['total_cents']; }
    if (!$sg) continue;
    if ($sg > 0) $docs++;
    $monto = $e['total_cents'] * $sg;
    $A->add($e['fondo'] === 'reserva' ? 'extraordinarios' : 'ordinarios', "{$e['codigo']} · {$e['partida']}", $sg < 0 ? "Cancelación · {$e['concepto']}" : $e['concepto'], $monto,
      ['folio' => $e['folio'], 'fecha' => $sg < 0 ? $e['fc'] : $e['f'], 'proveedor' => $e['proveedor'], 'estado' => $sg < 0 ? 'cancelado' : $e['estado'], 'factura' => $e['factura_folio'], 'fondo' => $e['fondo_nombre'] ?: ($e['fondo'] === 'reserva' ? 'Fondo de reserva' : null)]);
    if ($e['estado'] === 'pagado') $pagado += $monto; elseif ($e['estado'] === 'aprobado') $porPagar += $monto; else $ajuste += $monto;
    $pn = $e['proveedor'] ?: 'Sin proveedor';
    acumular($prov, $pn, ['proveedor' => $pn], $monto);
    if ($e['estado'] === 'pagado') {
      acumular($met, (string)$e['metodo_pago'], ['metodo' => METODO_NOMBRE[$e['metodo_pago']] ?? ($e['metodo_pago'] ?: 'Otro')], $monto);
      $cn = $e['cuenta'] ? "{$e['banco']} · {$e['cuenta']}" : 'Caja (efectivo)';
      acumular($cts, $cn, ['cuenta' => $cn], $monto);
    }
  }
  $grupos = $A->salida(); $total = suma($grupos, 'total');
  $presupuesto = null;
  if ($detalle && substr($desde, 0, 4) === substr($hasta, 0, 4)) {
    $pvr = presupuestoVsReal($db, $cid, (int)substr($desde, 0, 4));
    $m0 = (int)substr($desde, 5, 2) - 1; $m1 = (int)substr($hasta, 5, 2);
    $por = []; foreach ($pvr['rows'] as $r) $por["{$r['codigo']} · {$r['nombre']}"] = array_sum(array_slice($r['presupuesto'], $m0, $m1 - $m0));
    $oi = null; foreach ($grupos as $i => $g) if ($g['clave'] === 'ordinarios') $oi = $i;
    $presupuesto = ['total' => array_sum($por), 'ejercido' => $oi !== null ? $grupos[$oi]['total'] : 0, 'aprobado' => ($pvr['presupuesto']['estado'] ?? null) === 'aprobado'];
    if ($oi !== null) foreach ($grupos[$oi]['clasificaciones'] as &$c) { $c['presupuesto'] = $por[$c['nombre']] ?? 0; } unset($c);
    $nombres = $oi !== null ? col($grupos[$oi]['clasificaciones'], 'nombre') : [];
    $presupuesto['sin_gasto'] = [];
    foreach ($por as $n => $v) if ($v > 0 && !in_array((string)$n, $nombres, true)) $presupuesto['sin_gasto'][] = ['nombre' => (string)$n, 'presupuesto' => $v];
  }
  $ant = periodoAnterior($desde, $hasta);
  return ['desde' => $desde, 'hasta' => $hasta, 'documentos' => $docs, 'total' => $total, 'pagado' => $pagado, 'por_pagar' => $porPagar, 'cancelado_neto' => $ajuste, 'grupos' => $grupos, 'cancelados' => $cancel,
    'por_proveedor' => ordenMonto($prov), 'por_metodo' => ordenMonto($met), 'por_cuenta' => ordenMonto($cts), 'presupuesto' => $presupuesto,
    'anterior' => $detalle ? $ant + ['total' => egresosReporte($db, $cid, $ant['desde'], $ant['hasta'], false)['total']] : null];
}
function egresosMensual(DB $db, int $cid, int $anio): array {
  $pvr = presupuestoVsReal($db, $cid, $anio);
  $pres = array_map(fn($i) => suma($pvr['rows'], fn($r) => $r['presupuesto'][$i]), range(0, 11));
  return ['anio' => $anio, 'meses' => array_map(function ($p, $i) use ($db, $cid, $pres) {
    $r = egresosReporte($db, $cid, "{$p}-01", finDeMes($p), false);
    $g = []; foreach ($r['grupos'] as $x) $g[$x['clave']] = $x['total'];
    return ['periodo' => $p] + $g + ['total' => $r['total'], 'documentos' => $r['documentos'], 'presupuesto' => $pres[$i], 'clasificaciones' => clasifDe($r['grupos'])];
  }, meses("{$anio}-01", "{$anio}-12"), range(0, 11))];
}
function saldosBancarios(DB $db, int $cid, string $d, string $h): array {
  $cuentas = [...$db->prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id, k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id WHERE b.condominio_id = ? AND b.activo = 1 ORDER BY b.fondo, b.id')->all($cid),
    ['id' => null, 'nombre' => 'Efectivo', 'banco' => 'Caja', 'numero_mask' => null, 'fondo' => 'operacion', 'cuenta_id' => cuenta($db, $cid, 'CAJA'), 'codigo' => '1101']];
  $al = fn($k, $p) => $db->prepare('SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo <= ?')->get($k, $p)['s'];
  $ps = $d === $h ? meses(addMonths($h, -5), $h) : meses($d, $h);
  $rows = [];
  foreach ($cuentas as $c) {
    $anterior = $al($c['cuenta_id'], addMonths($d, -1));
    $m = $db->prepare('SELECT COALESCE(SUM(m.debe_cents), 0) e, COALESCE(SUM(m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ?')->get($c['cuenta_id'], $d, $h);
    $saldo = $anterior;
    $movs = array_map(function ($x) use (&$saldo) { $saldo += $x['entrada'] - $x['salida']; return $x + ['saldo' => $saldo]; },
      $db->prepare("SELECT p.fecha, p.tipo || '-' || p.folio AS poliza, p.concepto, m.debe_cents AS entrada, m.haber_cents AS salida FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.periodo BETWEEN ? AND ? ORDER BY p.fecha, p.id, m.id LIMIT 1500")->all($c['cuenta_id'], $d, $h));
    $r = $c + ['anterior' => $anterior, 'ingresos' => $m['e'], 'egresos' => $m['s'], 'final' => $anterior + $m['e'] - $m['s'], 'serie' => array_map(fn($p) => ['periodo' => $p, 'saldo' => $al($c['cuenta_id'], $p)], $ps), 'movimientos' => $movs];
    if ($r['id'] || $r['anterior'] || $r['ingresos'] || $r['egresos']) $rows[] = $r;
  }
  $t = fn($k) => suma($rows, $k);
  return ['desde' => $d, 'hasta' => $h, 'cuentas' => $rows, 'totales' => ['anterior' => $t('anterior'), 'ingresos' => $t('ingresos'), 'egresos' => $t('egresos'), 'final' => $t('final')],
    'serie' => array_map(fn($p, $i) => ['periodo' => $p, 'saldo' => suma($rows, fn($c) => $c['serie'][$i]['saldo'])], $ps, array_keys($ps))];
}
function conciliacion(DB $db, int $cid, string $dP, string $hP): array {
  $corte = finDeMes($hP) < hoy() ? finDeMes($hP) : hoy(); $desde = "{$dP}-01";
  $bancos = $db->prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, b.cuenta_id FROM cuentas_banco b WHERE b.condominio_id = ? AND b.activo = 1 ORDER BY b.fondo, b.id')->all($cid);
  $libros = fn($k, $f) => $db->prepare('SELECT COALESCE(SUM(m.debe_cents - m.haber_cents), 0) s FROM movimientos m JOIN polizas p ON p.id = m.poliza_id WHERE m.cuenta_id = ? AND p.fecha <= ?')->get($k, $f)['s'];
  $cuentas = array_map(function ($b) use ($db, $libros, $corte, $desde) {
    $pr = $db->prepare('SELECT MIN(fecha) f, MAX(fecha) u FROM banco_movs WHERE cuenta_banco_id = ?')->get($b['id']);
    $enLibros = $libros($b['cuenta_id'], $corte);
    if (!$pr['f'] || $pr['f'] > $corte) return $b + ['sin_estado' => true, 'libros' => $enLibros];
    $base = $libros($b['cuenta_id'], addDays($pr['f'], -1));
    $bancoS = $base + $db->prepare('SELECT COALESCE(SUM(abono_cents - cargo_cents), 0) s FROM banco_movs WHERE cuenta_banco_id = ? AND fecha <= ?')->get($b['id'], $corte)['s'];
    $dp = $db->prepare('SELECT COUNT(*) n, COALESCE(SUM(abono_cents), 0) dep, COALESCE(SUM(cargo_cents), 0) ret, SUM(conciliado_tipo IS NOT NULL) conc FROM banco_movs WHERE cuenta_banco_id = ? AND fecha BETWEEN ? AND ?')->get($b['id'], $desde, $corte);
    $nr = $db->prepare("SELECT fecha, descripcion, referencia, abono_cents, cargo_cents, conciliado_tipo FROM banco_movs WHERE cuenta_banco_id = ? AND fecha <= ? AND (conciliado_tipo IS NULL OR conciliado_tipo = 'otro') ORDER BY fecha")->all($b['id'], $corte);
    $dt = $db->prepare("SELECT pol.fecha, 'R-' || p.folio || ' · ' || u.clave AS documento, p.referencia, p.monto_cents AS monto FROM pagos p JOIN polizas pol ON pol.id = p.poliza_id JOIN unidades u ON u.id = p.unidad_id
      WHERE p.cuenta_banco_id = ? AND p.estado = 'aplicado' AND pol.fecha BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'pago' AND x.conciliado_id = p.id) ORDER BY pol.fecha")->all($b['id'], $pr['f'], $corte);
    $pt = $db->prepare("SELECT pol.fecha, 'E-' || e.folio || ' · ' || e.concepto AS documento, e.referencia_pago AS referencia, e.total_cents AS monto FROM egresos e JOIN polizas pol ON pol.id = e.poliza_pago_id
      WHERE e.cuenta_banco_id = ? AND e.estado = 'pagado' AND pol.fecha BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM banco_movs x WHERE x.conciliado_tipo = 'egreso' AND x.conciliado_id = e.id) ORDER BY pol.fecha")->all($b['id'], $pr['f'], $corte);
    $ol = $db->prepare("SELECT p.fecha, p.tipo || '-' || p.folio || ' · ' || p.concepto AS documento, m.debe_cents - m.haber_cents AS monto FROM movimientos m JOIN polizas p ON p.id = m.poliza_id
      WHERE m.cuenta_id = ? AND p.fecha BETWEEN ? AND ? AND NOT (p.origen = 'pago' AND EXISTS (SELECT 1 FROM pagos g WHERE g.poliza_id = p.id AND g.estado = 'aplicado'))
        AND NOT (p.origen = 'pago_egreso' AND EXISTS (SELECT 1 FROM egresos e WHERE e.poliza_pago_id = p.id AND e.estado = 'pagado')) ORDER BY p.fecha, p.id")->all($b['cuenta_id'], $pr['f'], $corte);
    $anr = suma($nr, 'abono_cents'); $cnr = suma($nr, 'cargo_cents'); $dT = suma($dt, 'monto'); $pT = suma($pt, 'monto'); $oL = suma($ol, 'monto');
    $conc = $bancoS - $anr + $cnr + $dT - $pT + $oL;
    return array_merge($b, ['desde_estado' => $pr['f'], 'ultimo_mov' => $pr['u'], 'banco' => $b['banco'], 'saldo_banco' => $bancoS, 'libros' => $enLibros,
      'periodo' => ['movimientos' => $dp['n'], 'depositos' => $dp['dep'], 'retiros' => $dp['ret'], 'conciliados' => $dp['conc'] ?: 0],
      'abonos_no_registrados' => $anr, 'cargos_no_registrados' => $cnr, 'depositos_transito' => $dT, 'pagos_transito' => $pT, 'otros_libros' => $oL, 'saldo_conciliado' => $conc, 'diferencia' => $enLibros - $conc,
      'no_registrados' => $nr, 'depositos_en_transito' => $dt, 'pagos_en_transito' => $pt, 'otros_en_libros' => $ol]);
  }, $bancos);
  return ['desde' => $dP, 'hasta' => $hP, 'corte' => $corte, 'cuentas' => $cuentas];
}
