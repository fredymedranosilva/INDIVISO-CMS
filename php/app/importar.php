<?php
// Importación masiva desde Excel/CSV (equivale a server/importar.mjs). Cada fila corre en su propio SAVEPOINT y
// «validar» revierte toda la transacción: la vista previa es exactamente lo que ocurrirá al importar.
declare(strict_types=1);

function norm($s): string { return trim(preg_replace('/[^a-z0-9]+/', ' ', plano($s))); }
function compacto($s): string { return preg_replace('/\s+/', '', preg_replace('/\b(torre|edificio|edif|seccion|depto|departamento|casa|local|unidad|vivienda)\b/', '', norm($s))); }
function txt($x): string { return $x === null ? '' : trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', is_float($x) ? rtrim(rtrim(number_format($x, 10, '.', ''), '0'), '.') : (string)$x)); }
function pesosTxt(int $c): string { return '$' . number_format($c / 100, 2, '.', ','); }
function esNum($x): bool { return is_int($x) || is_float($x); }

function importe($x, bool $negativo = false, string $campo = 'Importe'): ?int {
  if (esNum($x)) {
    if (!is_finite((float)$x)) fail(400, "{$campo} inválido.");
    $c = jround($x * 100);
    if ($c < 0 && !$negativo) fail(400, "{$campo} no puede ser negativo.");
    if (abs($c) > 10000000000) fail(400, "{$campo} excede el máximo.");
    return $c;
  }
  $s = preg_replace('/\s|\$|MXN|M\.N\./i', '', txt($x));
  if ($s === '') return null;
  $neg = false;
  if (preg_match('/^\(.*\)$/', $s)) { $neg = true; $s = substr($s, 1, -1); }
  if (str_starts_with($s, '-')) { $neg = true; $s = substr($s, 1); }
  if (preg_match('/^\d{1,3}(\.\d{3})+,\d{1,2}$/', $s)) $s = str_replace(',', '.', str_replace('.', '', $s)); else $s = str_replace(',', '', $s);
  if (!preg_match('/^\d+(\.\d+)?$/', $s)) fail(400, "{$campo} «" . txt($x) . '» no es un importe válido.');
  $c = jround((float)$s * 100) * ($neg ? -1 : 1);
  if ($c < 0 && !$negativo) fail(400, "{$campo} no puede ser negativo.");
  if (abs($c) > 10000000000) fail(400, "{$campo} excede el máximo.");
  return $c;
}
function fechaImp($x, string $campo = 'Fecha'): ?string {
  $s = esNum($x) ? $x : txt($x);
  if ($s === '') return null;
  if (esNum($s) || preg_match('/^\d{5}(\.\d+)?$/', (string)$s)) {
    $n = (int)floor((float)$s);
    if ($n < 20000 || $n > 80000) fail(400, "{$campo} «{$s}» no es una fecha válida.");
    $out = (new DateTimeImmutable('1899-12-30T00:00:00Z'))->modify("+{$n} day")->format('Y-m-d');
  } else {
    $s = preg_replace('/[T ].*$/', '', $s);
    if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/', $s, $m)) $out = sprintf('%s-%02d-%02d', $m[1], $m[2], $m[3]);
    elseif (preg_match('/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/', $s, $m)) $out = sprintf('%s-%02d-%02d', strlen($m[3]) === 2 ? '20' . $m[3] : $m[3], $m[2], $m[1]);
    else fail(400, "{$campo} «{$s}» no es una fecha válida (use DD/MM/AAAA).");
  }
  if (!isDate($out)) fail(400, "{$campo} «" . txt($x) . '» no es una fecha válida.');
  return $out;
}
function boolImp($x, string $campo): ?bool {
  $s = norm($x); if ($s === '') return null;
  if (in_array($s, ['si', 's', 'x', '1', 'true', 'verdadero', 'yes', 'activa', 'activo', 'pagado', 'pagada'], true)) return true;
  if (in_array($s, ['no', 'n', '0', 'false', 'falso', 'inactiva', 'inactivo'], true)) return false;
  fail(400, "{$campo} «" . txt($x) . '»: use Sí o No.');
}
const METODO_SAT = ['01' => 'efectivo', '1' => 'efectivo', '02' => 'cheque', '2' => 'cheque', '03' => 'transferencia', '3' => 'transferencia', '04' => 'tarjeta', '4' => 'tarjeta', '28' => 'tarjeta', '29' => 'tarjeta'];
function metodoImp($x, array $permitidos): ?string {
  $s = norm($x); if ($s === '') return null;
  $m = METODO_SAT[preg_replace('/\s.*$/', '', $s)] ?? null;
  if (!$m) {
    if (preg_match('/efectivo|caja|cash/', $s)) $m = 'efectivo';
    elseif (preg_match('/transfer|spei|electronica|banca en linea/', $s)) $m = 'transferencia';
    elseif (preg_match('/deposito|ventanilla/', $s)) $m = 'deposito';
    elseif (preg_match('/cheque/', $s)) $m = 'cheque';
    elseif (preg_match('/tarjeta|debito|credito|tpv|terminal/', $s)) $m = 'tarjeta';
    elseif (preg_match('/domicilia|cargo automatico/', $s)) $m = 'domiciliacion';
  }
  if (!$m || !in_array($m, $permitidos, true)) fail(400, 'Forma de pago «' . txt($x) . '» no reconocida. Use: ' . implode(', ', $permitidos) . '.');
  return $m;
}
const MESES_IMP = [['ene', 'enero', 'jan'], ['feb', 'febrero'], ['mar', 'marzo'], ['abr', 'abril', 'apr'], ['may', 'mayo'], ['jun', 'junio'], ['jul', 'julio'], ['ago', 'agosto', 'aug'], ['sep', 'sept', 'septiembre', 'setiembre'], ['oct', 'octubre'], ['nov', 'noviembre'], ['dic', 'diciembre', 'dec']];
function esEjemplo($c): bool { return is_string($c) && str_starts_with(norm($c), 'ejemplo'); }

// ---------- Búsquedas en catálogos ----------
final class Buscador {
  private array $idx = [];
  public function __construct(array $items, callable $claves) { foreach ($items as $it) foreach ($claves($it) as $k) { $this->add(norm($k), $it); $this->add(compacto($k), $it); } }
  private function add(string $k, $it): void { if ($k === '') return; $p = $this->idx[$k] ?? null; $this->idx[$k] = ($p !== null && $p !== $it) ? 'AMBIGUO' : $it; }
  public function __invoke($q) { $a = $this->idx[norm($q)] ?? $this->idx[compacto($q)] ?? null; return $a; }
}
function catalogosImp(DB $db, int $cid): array {
  return [
    'unidades' => $db->prepare('SELECT id, clave, torre, referencia, activo FROM unidades WHERE condominio_id = ?')->all($cid),
    'bancos' => $db->prepare('SELECT b.id, b.nombre, b.banco, b.numero_mask, b.fondo, k.codigo FROM cuentas_banco b JOIN cuentas k ON k.id = b.cuenta_id WHERE b.condominio_id = ? AND b.activo = 1')->all($cid),
    'partidas' => $db->prepare("SELECT id, codigo, nombre, tipo_gasto FROM cuentas WHERE condominio_id = ? AND tipo = 'egreso' AND activo = 1 ORDER BY codigo")->all($cid),
    'proveedores' => $db->prepare('SELECT id, nombre, rfc FROM proveedores WHERE condominio_id = ?')->all($cid),
  ];
}
function torreCorta($t): string { return preg_replace('/^(torre|edificio|edif\.?|secci[oó]n|privada|bloque)\s*/iu', '', txt($t)); }
function buscarUnidad(object $aux, array $r): array {
  $q = txt($r['unidad'] ?? ''); if ($q === '') fail(400, 'Falta la unidad.');
  $t = $r['torre'] ?? '';
  $cands = txt($t) !== '' ? [torreCorta($t) . "-{$q}", txt($t) . " {$q}", $q] : [$q];
  foreach ($cands as $c) { $u = ($aux->unidad)($c); if ($u === 'AMBIGUO') fail(400, "La unidad «{$c}» coincide con varias; use la clave exacta."); if ($u) return $u; }
  fail(400, 'No existe la unidad «' . (txt($t) !== '' ? txt($t) . " {$q}" : $q) . '».');
}
// Devuelve: false = sin dato (undefined en JS), null = caja, array = banco
function buscarBanco(object $aux, $q) {
  $s = txt($q); if ($s === '') return false;
  if (preg_match('/^(caja|efectivo|caja chica)$/', norm($s))) return null;
  $b = ($aux->banco)($s);
  if ($b === null) $lista = preg_match('/^\d{4}$/', $s) ? filt($aux->bancos, fn($x) => str_ends_with((string)$x['numero_mask'], $s))
    : filt($aux->bancos, fn($x) => str_contains(norm("{$x['banco']} {$x['nombre']}"), norm($s)) || str_contains(norm($s), norm("{$x['banco']} {$x['nombre']}")));
  else $lista = $b === 'AMBIGUO' ? [1, 2] : [$b];
  if (count($lista) > 1) fail(400, "La cuenta «{$s}» coincide con varias; use el código de la hoja Catálogos.");
  if (!$lista) fail(400, "No existe la cuenta bancaria «{$s}».");
  return $lista[0];
}
function buscarPartida(object $aux, $q, Ctx $ctx): ?array {
  $s = txt($q); if ($s === '') return null;
  $k = ($aux->partida)($s) ?? ($aux->partida)(preg_split('/\s*[·|-]\s*/u', $s)[0]);
  if ($k === null) {
    $ns = norm($s);
    $parc = filt($aux->partidas, fn($p) => str_contains($ns, norm($p['nombre'])) || str_contains(norm($p['nombre']), $ns));
    if (count($parc) === 1) $k = $parc[0];
    elseif (count($parc) > 1) { $ex = filt($parc, fn($p) => str_ends_with($ns, norm($p['nombre']))); if (count($ex) === 1) $k = $ex[0]; else fail(400, "La partida «{$s}» coincide con varias: " . implode(', ', col(array_slice($parc, 0, 4), 'codigo')) . '.'); }
  }
  if ($k === 'AMBIGUO') fail(400, "La partida «{$s}» coincide con varias; use su código.");
  if ($k) return $k;
  if (!$aux->crearPartidas) fail(400, "No existe la partida «{$s}». Créela en Contabilidad o active «crear partidas nuevas».");
  $nombre = mslice(preg_replace('/^.*?\s-\s(?=\S)/u', '', $s), 0, 120) ?: mslice($s, 0, 120);
  $usados = col($ctx->db->prepare('SELECT codigo FROM cuentas WHERE condominio_id = ?')->all($ctx->cid), 'codigo');
  $n = 5600; while (in_array((string)$n, $usados, true) && $n < 5999) $n++;
  if ($n >= 5999) fail(400, 'No hay códigos libres para crear la partida.');
  $id = $ctx->db->prepare("INSERT INTO cuentas (condominio_id, codigo, nombre, tipo, naturaleza, presupuestable, tipo_gasto) VALUES (?,?,?,'egreso','D',1,'variable')")->run($ctx->cid, (string)$n, $nombre)['lastInsertRowid'];
  $nueva = ['id' => $id, 'codigo' => (string)$n, 'nombre' => $nombre, 'nueva' => true];
  $aux->partidas[] = $nueva; $aux->partida = new Buscador($aux->partidas, fn($p) => [$p['codigo'], $p['nombre']]);
  $aux->creadas[] = "{$n} · {$nombre}";
  return $nueva;
}

// ---------- Definición de cada importación ----------
function tiposImp(): array {
  $mesesCols = []; foreach (MESES_IMP as $i => $n) $mesesCols['m' . ($i + 1)] = [...$n, (string)($i + 1), 'mes ' . ($i + 1)];
  return [
  'pagos' => ['perm' => 'capturar', 'columnas' => [
      'unidad' => ['unidad', 'clave', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'condomino', 'referencia de pago', 'clave unidad', 'numero'],
      'torre' => ['torre', 'edificio', 'seccion', 'bloque'],
      'fecha' => ['fecha', 'fecha de pago', 'fecha pago', 'fecha del pago', 'fecha deposito'],
      'importe' => ['importe', 'monto', 'cantidad', 'pago', 'total', 'importe pagado', 'abono', 'deposito'],
      'metodo' => ['forma de pago', 'metodo', 'metodo de pago', 'forma pago', 'tipo de pago'],
      'cuenta' => ['cuenta bancaria', 'cuenta', 'banco', 'cuenta de caja o banco', 'cuenta deposito', 'caja o banco'],
      'referencia' => ['referencia', 'clave de rastreo', 'rastreo', 'folio', 'referencia bancaria', 'autorizacion', 'no operacion'],
      'notas' => ['comentarios', 'notas', 'observaciones', 'concepto', 'descripcion']],
    'req' => ['unidad', 'fecha', 'importe'],
    'vacia' => fn($r) => txt($r['importe'] ?? '') === '' && txt($r['fecha'] ?? '') === '',
    'fila' => function (Ctx $ctx, array $r, object $aux, callable $ocurr) {
      $u = buscarUnidad($aux, $r);
      $f = fechaImp($r['fecha'] ?? '');
      if ($f === null) fail(400, 'Falta la fecha.');
      if ($f > hoy()) fail(400, 'La fecha de pago no puede ser futura.');
      $monto = importe($r['importe'] ?? '');
      if (!$monto) fail(400, 'El importe debe ser mayor a cero.');
      $b = buscarBanco($aux, $r['cuenta'] ?? '');
      $met = metodoImp($r['metodo'] ?? '', ['transferencia', 'deposito', 'efectivo', 'tarjeta', 'cheque', 'domiciliacion']);
      $banco = $b !== false ? $b : ($met === 'efectivo' ? null : ($aux->bancoDefecto ?? false));
      if ($banco === false) fail(400, 'Indique la cuenta bancaria donde se recibió (o elija una cuenta por defecto).');
      if (!$met) $met = $banco ? 'transferencia' : 'efectivo';
      if (!$banco && $met !== 'efectivo') fail(400, 'Un pago registrado en caja debe ser en efectivo.');
      $ref = mslice(txt($r['referencia'] ?? ''), 0, 60) ?: null;
      $base = implode('|', [$ctx->cid, $u['id'], $f, $monto, $ref ?? '']);
      $idem = 'IMP-P-' . substr(sha256($base . '|' . $ocurr($base)), 0, 48);
      $res = registrarPago($ctx->db, $ctx->cid, ['unidad_id' => $u['id'], 'fecha' => $f, 'monto_cents' => $monto, 'metodo' => $met, 'referencia' => $ref, 'cuenta_banco_id' => $banco['id'] ?? null,
        'notas' => mslice(txt($r['notas'] ?? ''), 0, 300) ?: null, 'idem_key' => $idem, 'confirmar_duplicado' => $aux->confirmarDuplicados], $ctx->user);
      if (!empty($res['repetido'])) return ['accion' => 'omitido', 'detalle' => "Ya importado antes (recibo R-{$res['folio']})."];
      return ['accion' => 'creado', 'detalle' => "{$u['clave']} · " . pesosTxt($monto) . " · recibo R-{$res['folio']}" . ($res['saldo_favor'] ? ' · ' . pesosTxt($res['saldo_favor']) . ' a favor' : ''), 'monto' => $monto];
    }],

  'egresos' => ['perm' => 'capturar', 'columnas' => [
      'concepto' => ['concepto', 'descripcion', 'detalle'],
      'proveedor' => ['proveedor', 'beneficiario', 'razon social', 'nombre proveedor'],
      'importe' => ['importe', 'total', 'monto', 'importe total', 'cantidad'],
      'fecha' => ['fecha', 'fecha del gasto', 'fecha egreso', 'fecha de pago'],
      'metodo' => ['forma de pago', 'metodo', 'metodo de pago', 'forma pago'],
      'cuenta' => ['cuenta bancaria', 'cuenta', 'banco', 'cuenta de cargo', 'caja o banco'],
      'referencia' => ['referencia', 'clave de rastreo', 'rastreo', 'cheque', 'no cheque'],
      'partida' => ['clasificacion presupuestal', 'partida', 'partida presupuestal', 'clasificacion', 'cuenta de gasto', 'rubro', 'categoria'],
      'fondo' => ['fondo'],
      'comentarios' => ['comentarios', 'notas', 'observaciones']],
    'req' => ['concepto', 'fecha', 'importe'],
    'prep' => function (Ctx $ctx, object $aux) { $aux->provNuevos = []; $aux->fondos = $ctx->db->prepare('SELECT id, nombre FROM fondos WHERE condominio_id = ? AND activo = 1')->all($ctx->cid); },
    'fila' => function (Ctx $ctx, array $r, object $aux, callable $ocurr) {
      $f = fechaImp($r['fecha'] ?? '');
      if ($f === null) fail(400, 'Falta la fecha.');
      if ($f > hoy()) fail(400, 'La fecha del gasto no puede ser futura.');
      $concepto = txt($r['concepto'] ?? '');
      if ($concepto === '') fail(400, 'Falta el concepto.');
      $com = txt($r['comentarios'] ?? '');
      if ($com !== '' && mlen($concepto) + mlen($com) + 3 <= 200) $concepto = "{$concepto} · {$com}";
      $concepto = mslice($concepto, 0, 200);
      $total = importe($r['importe'] ?? '');
      if (!$total) fail(400, 'El importe debe ser mayor a cero.');
      $partida = buscarPartida($aux, $r['partida'] ?? '', $ctx) ?? $aux->partidaDefecto ?? fail(400, 'Indique la clasificación presupuestal (o elija una por defecto).');
      $ft = norm($r['fondo'] ?? ''); $fondo = 'operacion'; $fondoId = null;
      if ($ft !== '' && !preg_match('/ordinari|operacion|corriente|mantenimiento|general/', preg_replace('/extraordinari/', 'X', $ft))) {
        $fe = find($aux->fondos, fn($x) => norm($x['nombre']) === $ft || str_contains($ft, norm($x['nombre'])));
        if ($fe) { $fondo = 'reserva'; $fondoId = $fe['id']; }
        elseif (preg_match('/reserva|extraordinari/', $ft)) $fondo = 'reserva';
        else fail(400, 'Fondo «' . txt($r['fondo']) . '» no reconocido: use Operación, Reserva o el nombre de un fondo.');
      }
      $provId = null; $pn = mslice(txt($r['proveedor'] ?? ''), 0, 160);
      if ($pn !== '') {
        $p = find($aux->proveedores, fn($x) => norm($x['nombre']) === norm($pn));
        if (!$p) { $p = ['id' => $ctx->db->prepare('INSERT INTO proveedores (condominio_id, nombre, created_at) VALUES (?,?,?)')->run($ctx->cid, $pn, now_ms())['lastInsertRowid'], 'nombre' => $pn, 'rfc' => null]; $aux->proveedores[] = $p; $aux->provNuevos[] = $pn; }
        $provId = $p['id'];
      }
      $base = implode('|', [$ctx->cid, $f, $total, norm($concepto), $provId ?? '']);
      $idem = 'IMP-E-' . substr(sha256($base . '|' . $ocurr($base)), 0, 48);
      $e = crearEgreso($ctx->db, $ctx->cid, ['proveedor_id' => $provId, 'cuenta_id' => $partida['id'], 'fondo' => $fondo, 'fondo_id' => $fondoId, 'fecha' => $f, 'concepto' => $concepto, 'subtotal_cents' => $total, 'iva_cents' => 0, 'retenciones_cents' => 0, 'idem_key' => $idem], $ctx->user);
      if (!empty($e['repetido'])) return ['accion' => 'omitido', 'detalle' => "Ya importado antes (E-{$e['folio']})."];
      $b = buscarBanco($aux, $r['cuenta'] ?? '');
      $met = metodoImp($r['metodo'] ?? '', ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'domiciliacion']);
      $pagado = '';
      if ($aux->registrarPago || $b !== false || $met) {
        if ($e['estado'] !== 'aprobado') $pagado = ' · requiere aprobación; regístrelo como pagado después de aprobarlo';
        else {
          $banco = $b === false ? ($met === 'efectivo' ? null : ($aux->bancoDefecto ?? fail(400, 'Indique la cuenta bancaria de donde salió el pago (o elija una por defecto).'))) : $b;
          pagarEgreso($ctx->db, $ctx->cid, $e['id'], ['fecha_pago' => $f, 'metodo' => $met ?: ($banco ? 'transferencia' : 'efectivo'), 'cuenta_banco_id' => $banco['id'] ?? null, 'referencia' => mslice(txt($r['referencia'] ?? ''), 0, 60) ?: null], $ctx->user);
          $pagado = ' · pagado';
        }
      }
      return ['accion' => 'creado', 'detalle' => "E-{$e['folio']} · {$partida['codigo']} · " . pesosTxt($total) . ($e['estado'] === 'por_aprobar' && !$pagado ? ' · espera aprobación' : '') . $pagado, 'monto' => $total];
    }],

  'proveedores' => ['perm' => 'capturar', 'columnas' => [
      'nombre' => ['nombre', 'razon social', 'proveedor', 'nombre o razon social'], 'rfc' => ['rfc'], 'giro' => ['giro', 'servicio', 'actividad', 'categoria'],
      'email' => ['correo', 'email', 'correo electronico', 'e mail'], 'telefono' => ['telefono', 'tel', 'celular', 'movil'], 'clabe' => ['clabe', 'cuenta clabe', 'clabe interbancaria']],
    'req' => ['nombre'],
    'fila' => function (Ctx $ctx, array $r, object $aux) {
      $nz = fn($k) => txt($r[$k] ?? '') !== '' ? txt($r[$k]) : null;
      $d = v(['nombre' => txt($r['nombre'] ?? ''), 'rfc' => $nz('rfc'), 'giro' => $nz('giro'), 'email' => $nz('email'), 'telefono' => $nz('telefono'), 'clabe' => preg_replace('/\s/', '', txt($r['clabe'] ?? '')) ?: null],
        ['nombre' => 'str|max160', 'rfc' => 'rfc|opt', 'giro' => 'str|opt|max80', 'email' => 'email|opt', 'telefono' => 'str|opt|max30', 'clabe' => 'str|opt|max18']);
      if ($d['clabe'] && !preg_match('/^\d{18}$/', $d['clabe'])) fail(400, 'La CLABE debe tener 18 dígitos.');
      $p = ($d['rfc'] ? find($aux->proveedores, fn($x) => $x['rfc'] === $d['rfc']) : null) ?? find($aux->proveedores, fn($x) => norm($x['nombre']) === norm($d['nombre']));
      if ($p) {
        $a = $ctx->db->prepare('SELECT giro, email, telefono, clabe_mask, rfc FROM proveedores WHERE id = ?')->get($p['id']);
        $n = ['giro' => $d['giro'] ?? $a['giro'], 'email' => $d['email'] ?? $a['email'], 'telefono' => $d['telefono'] ?? $a['telefono'], 'clabe_mask' => mask($d['clabe']) ?? $a['clabe_mask'], 'rfc' => $a['rfc'] ?? $d['rfc']];
        if ($n == $a) return ['accion' => 'omitido', 'detalle' => "{$p['nombre']} · sin cambios"];
        $ctx->db->prepare('UPDATE proveedores SET giro = ?, email = ?, telefono = ?, clabe_mask = ?, rfc = ? WHERE id = ?')->run($n['giro'], $n['email'], $n['telefono'], $n['clabe_mask'], $n['rfc'], $p['id']);
        return ['accion' => 'actualizado', 'detalle' => "{$p['nombre']} · datos de contacto actualizados"];
      }
      $id = $ctx->db->prepare('INSERT INTO proveedores (condominio_id, nombre, rfc, giro, email, telefono, clabe_mask, created_at) VALUES (?,?,?,?,?,?,?,?)')->run($ctx->cid, $d['nombre'], $d['rfc'], $d['giro'], $d['email'], $d['telefono'], mask($d['clabe']), now_ms())['lastInsertRowid'];
      $aux->proveedores[] = ['id' => $id, 'nombre' => $d['nombre'], 'rfc' => $d['rfc']];
      return ['accion' => 'creado', 'detalle' => $d['nombre'] . ($d['rfc'] ? " · {$d['rfc']}" : '')];
    }],

  'directorio' => ['perm' => 'config', 'columnas' => [
      'unidad' => ['clave', 'unidad', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'numero', 'vivienda casa departamento', 'no'],
      'torre' => ['torre', 'seccion', 'edificio', 'bloque', 'privada'], 'tipo' => ['tipo', 'tipo de unidad'],
      'superficie' => ['m2', 'superficie', 'metros', 'metros cuadrados', 'area', 'superficie m2'],
      'indiviso' => ['indiviso', 'indiviso %', 'porcentaje de indiviso', 'proindiviso', 'factor', 'participacion'],
      'cuota' => ['cuota', 'cuota mensual', 'cuota ordinaria', 'mantenimiento', 'cuota de mantenimiento'],
      'estado' => ['ocupacion', 'estado', 'estatus ocupacion', 'ocupada'], 'activa' => ['activa', 'estatus', 'estatus de vivienda', 'activo'],
      'propietario' => ['propietario', 'nombre', 'contacto principal', 'condomino', 'nombre propietario', 'contacto'],
      'email' => ['correo', 'email', 'correo propietario', 'e mail', 'correo electronico'], 'telefono' => ['telefono', 'tel', 'celular', 'telefono propietario'],
      'rfc' => ['rfc', 'rfc propietario'], 'inquilino' => ['inquilino', 'arrendatario', 'nombre inquilino'], 'email_inq' => ['correo inquilino', 'email inquilino'],
      'tel_inq' => ['telefono inquilino', 'tel inquilino'], 'notas' => ['notas', 'comentarios', 'observaciones']],
    'req' => ['unidad'],
    'prep' => function (Ctx $ctx, object $aux, array $filas) {
      $s = 0.0; foreach ($filas as $r) { $x = $r['indiviso'] ?? ''; if ($x === '' || $x === null) continue; $n = str_replace(',', '.', str_replace('%', '', txt($x))); if (is_numeric($n)) $s += (float)$n; }
      $aux->indivisoFraccion = $s > 0 && $s <= 1.0001;
      $aux->personas = $ctx->db->prepare('SELECT id, nombre, email, telefono, rfc FROM personas WHERE condominio_id = ? AND activo = 1')->all($ctx->cid);
    },
    'fila' => function (Ctx $ctx, array $r, object $aux) {
      $db = $ctx->db;
      $q = txt($r['unidad'] ?? ''); if ($q === '') fail(400, 'Falta la clave de la unidad.');
      $u = null;
      try { $u = buscarUnidad($aux, $r); } catch (AppError $e) { if (!str_contains($e->getMessage(), 'No existe')) throw $e; }
      $TU = ['departamento', 'casa', 'local', 'oficina', 'bodega', 'estacionamiento'];
      $tipo = txt($r['tipo'] ?? '') !== '' ? (find($TU, fn($t) => str_starts_with(norm($r['tipo']), substr($t, 0, 4))) ?? fail(400, 'Tipo «' . txt($r['tipo']) . '» no reconocido: ' . implode(', ', $TU) . '.')) : null;
      $est = norm($r['estado'] ?? '');
      $estado = $est === '' ? null : (preg_match('/desocupad|vacant|vacia|libre/', $est) ? 'vacante' : (preg_match('/renta|arrend/', $est) ? 'renta' : (preg_match('/ocupad|habitad|propietario/', $est) ? 'ocupada' : fail(400, 'Ocupación «' . txt($r['estado']) . '»: use Ocupada, Vacante o En renta.'))));
      $ind = null;
      if (txt($r['indiviso'] ?? '') !== '') {
        $s = str_replace(',', '.', str_replace('%', '', txt($r['indiviso'])));
        if (!is_numeric($s) || (float)$s < 0 || (float)$s > 100) fail(400, 'Indiviso «' . txt($r['indiviso']) . '» inválido.');
        $ind = jround(($aux->indivisoFraccion ? (float)$s * 100 : (float)$s) * 10000);
      }
      $cuota = txt($r['cuota'] ?? '') !== '' ? importe($r['cuota'], false, 'Cuota') : null;
      $m2 = null;
      if (txt($r['superficie'] ?? '') !== '') { $s = str_replace(',', '', txt($r['superficie'])); if (!is_numeric($s)) fail(400, 'Superficie inválida.'); $m2 = jround((float)$s); if ($m2 < 0 || $m2 > 100000) fail(400, 'Superficie inválida.'); }
      $activa = boolImp($r['activa'] ?? '', 'Activa');
      $torre = mslice(txt($r['torre'] ?? ''), 0, 30) ?: null;
      $notas = mslice(txt($r['notas'] ?? ''), 0, 300) ?: null;
      $cambios = 0;
      if ($u) {
        $a = $db->prepare('SELECT * FROM unidades WHERE id = ?')->get($u['id']);
        $n = ['torre' => $torre ?? $a['torre'], 'tipo' => $tipo ?? $a['tipo'], 'm2' => $m2 ?? $a['m2'], 'indiviso_ppm' => $ind ?? $a['indiviso_ppm'], 'cuota_cents' => $cuota ?? $a['cuota_cents'], 'estado' => $estado ?? $a['estado'], 'notas' => $notas ?? $a['notas'], 'activo' => $activa === null ? $a['activo'] : ($activa ? 1 : 0)];
        if (some(array_keys($n), fn($k) => ($n[$k] === null) !== ($a[$k] === null) || $n[$k] != $a[$k])) {
          $db->prepare('UPDATE unidades SET torre = ?, tipo = ?, m2 = ?, indiviso_ppm = ?, cuota_cents = ?, estado = ?, notas = ?, activo = ? WHERE id = ?')->run($n['torre'], $n['tipo'], $n['m2'], $n['indiviso_ppm'], $n['cuota_cents'], $n['estado'], $n['notas'], $n['activo'], $u['id']);
          $cambios++;
        }
        $accion = 'actualizado';
      } else {
        $tc = torreCorta($torre);
        $clave = mslice($torre && $tc !== '' && preg_match('/^\d/', $q) && !str_starts_with(norm($q), norm($tc) . ' ') ? "{$tc}-{$q}" : $q, 0, 20);
        $ref = referenciaPago($db, $ctx->cid, $clave);
        $id = $db->prepare('INSERT INTO unidades (condominio_id, clave, torre, tipo, m2, indiviso_ppm, cuota_cents, referencia, estado, notas, activo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          ->run($ctx->cid, $clave, $torre, $tipo ?: 'departamento', $m2, $ind ?? 0, $cuota ?? 0, $ref, $estado ?: 'ocupada', $notas, $activa === false ? 0 : 1, now_ms())['lastInsertRowid'];
        $u = ['id' => $id, 'clave' => $clave, 'torre' => $torre, 'referencia' => $ref, 'activo' => 1];
        $aux->unidades[] = $u; $aux->unidad = new Buscador($aux->unidades, fn($x) => [$x['clave'], $x['referencia'], $x['torre'] ? "{$x['torre']} {$x['clave']}" : null]);
        $accion = 'creado';
      }
      $pers = [];
      foreach ([['propietario', $r['propietario'] ?? '', $r['email'] ?? '', $r['telefono'] ?? '', $r['rfc'] ?? ''], ['inquilino', $r['inquilino'] ?? '', $r['email_inq'] ?? '', $r['tel_inq'] ?? '', '']] as [$rol, $nombre, $email, $tel, $rfc]) {
        $n = mslice(txt($nombre), 0, 120); if ($n === '') continue;
        $d = v(['email' => preg_split('/[;,\s]+/', txt($email))[0] ?: null, 'telefono' => mslice(txt($tel), 0, 30) ?: null, 'rfc' => txt($rfc) ?: null], ['email' => 'email|opt', 'telefono' => 'str|opt|max30', 'rfc' => 'rfc|opt']);
        $vinc = $db->prepare('SELECT p.* FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = ? AND up.rol = ? ORDER BY up.id')->all($u['id'], $rol);
        if (count($vinc) > 1 && norm(implode(', ', col($vinc, 'nombre'))) === norm($n)) { $pers[] = "{$rol}: {$n}"; continue; }
        $p = find($vinc, fn($x) => norm($x['nombre']) === norm($n)) ?? ($d['email'] ? find($aux->personas, fn($x) => $x['email'] && mb_strtolower($x['email']) === $d['email']) : null);
        if (!$p) {
          $p = ['id' => $db->prepare('INSERT INTO personas (condominio_id, nombre, email, telefono, rfc, created_at) VALUES (?,?,?,?,?,?)')->run($ctx->cid, $n, $d['email'], $d['telefono'], $d['rfc'], now_ms())['lastInsertRowid'], 'nombre' => $n, 'email' => $d['email']];
          $aux->personas[] = $p; $cambios++;
        } else {
          $otro = $d['email'] ? find($aux->personas, fn($x) => $x['id'] !== $p['id'] && $x['email'] && mb_strtolower($x['email']) === $d['email']) : null;
          $a = $db->prepare('SELECT email, telefono, rfc FROM personas WHERE id = ?')->get($p['id']);
          $em = $d['email'] && !$otro ? $d['email'] : $a['email']; $te = $d['telefono'] ?? $a['telefono']; $rf = $d['rfc'] ?? $a['rfc'];
          if ($em !== $a['email'] || $te !== $a['telefono'] || $rf !== $a['rfc']) { $db->prepare('UPDATE personas SET email = ?, telefono = ?, rfc = ? WHERE id = ?')->run($em, $te, $rf, $p['id']); $cambios++; }
        }
        $cambios += $db->prepare('INSERT OR IGNORE INTO unidad_personas (unidad_id, persona_id, rol) VALUES (?,?,?)')->run($u['id'], $p['id'], $rol)['changes'];
        $pers[] = "{$rol}: {$n}";
      }
      if ($accion === 'actualizado' && !$cambios) return ['accion' => 'omitido', 'detalle' => "{$u['clave']} · sin cambios"];
      return ['accion' => $accion, 'detalle' => $u['clave'] . ($pers ? ' · ' . implode(' · ', $pers) : '') . ($cuota !== null ? ' · cuota ' . pesosTxt($cuota) : '') . ($ind !== null ? ' · indiviso ' . number_format($ind / 10000, 4, '.', '') . '%' : '')];
    }],

  'saldos' => ['perm' => 'config', 'columnas' => [
      'unidad' => ['unidad', 'clave', 'vivienda', 'departamento', 'depto', 'casa', 'local', 'numero'], 'torre' => ['torre', 'edificio', 'seccion'],
      'saldo' => ['saldo', 'saldo final', 'saldo inicial', 'saldo actual', 'balance'],
      'adeudo' => ['adeudo', 'cargo', 'debe', 'cuentas por cobrar', 'por cobrar', 'adeudo inicial'],
      'favor' => ['saldo a favor', 'a favor', 'anticipo', 'abono', 'haber'], 'concepto' => ['concepto', 'comentarios', 'notas']],
    'req' => ['unidad'],
    'vacia' => fn($r) => txt($r['saldo'] ?? '') === '' && txt($r['adeudo'] ?? '') === '' && txt($r['favor'] ?? '') === '',
    'fila' => function (Ctx $ctx, array $r, object $aux) {
      $u = buscarUnidad($aux, $r);
      if (txt($r['saldo'] ?? '') !== '') {
        $s = txt($r['saldo']); $af = (bool)preg_match('/favor/i', $s);
        $monto = importe($af ? preg_replace('/\(?\s*a\s+favor\s*\)?/i', '', $s) : $r['saldo'], true, 'Saldo');
        if ($af) $monto = -abs((int)$monto);
      } else $monto = (importe($r['adeudo'] ?? '', false, 'Adeudo') ?? 0) - (importe($r['favor'] ?? '', false, 'Saldo a favor') ?? 0);
      if (!$monto) return ['accion' => 'omitido', 'detalle' => "{$u['clave']} · saldo en cero"];
      $res = saldoInicial($ctx->db, $ctx->cid, ['unidad_id' => $u['id'], 'monto_cents' => $monto, 'fecha' => $aux->fechaCorte, 'concepto' => mslice(txt($r['concepto'] ?? ''), 0, 120) ?: null], $ctx->user);
      if (!empty($res['omitido'])) return ['accion' => 'omitido', 'detalle' => "{$u['clave']} · {$res['motivo']}"];
      return ['accion' => 'creado', 'detalle' => "{$u['clave']} · " . ($res['tipo'] === 'adeudo' ? 'adeudo' : 'saldo a favor') . ' ' . pesosTxt($res['monto']), 'monto' => $res['monto']];
    }],

  'cuotas' => ['perm' => 'config', 'columnas' => [
      'unidad' => ['codigo', 'codigo de unidad', 'codigo unidad', 'clave', 'unidad', 'departamento', 'depto', 'vivienda'],
      'cuota' => ['cuota', 'cuota mensual', 'cuota ordinaria', 'mantenimiento', 'importe', 'monto'], 'concepto' => ['comentarios', 'notas', 'concepto']],
    'req' => ['unidad', 'cuota'],
    'vacia' => fn($r) => txt($r['cuota'] ?? '') === '',
    'prep' => function (Ctx $ctx, object $aux) { $aux->vistas = []; },
    'fila' => function (Ctx $ctx, array $r, object $aux) {
      $q = txt($r['unidad'] ?? ''); if ($q === '') fail(400, 'Falta el código de la unidad.');
      $u = ($aux->unidad)($q);
      if ($u === 'AMBIGUO') fail(400, "El código «{$q}» coincide con varias unidades.");
      if (!$u) fail(400, "No existe una unidad con el código «{$q}».");
      if (isset($aux->vistas[$u['id']])) fail(400, "La unidad {$u['clave']} aparece dos veces en el archivo.");
      $aux->vistas[$u['id']] = true;
      $cuota = importe($r['cuota'] ?? '', false, 'Cuota');
      if ($cuota === null) fail(400, 'Indique la cuota mensual.');
      $antes = $ctx->db->prepare('SELECT cuota_cents FROM unidades WHERE id = ?')->get($u['id'])['cuota_cents'];
      if ($antes === $cuota) return ['accion' => 'omitido', 'detalle' => "{$u['clave']} · sin cambio (" . pesosTxt($cuota) . ')'];
      $ctx->db->prepare('UPDATE unidades SET cuota_cents = ? WHERE id = ? AND condominio_id = ?')->run($cuota, $u['id'], $ctx->cid);
      return ['accion' => 'actualizado', 'detalle' => "{$u['clave']} · " . pesosTxt($antes) . ' → ' . pesosTxt($cuota), 'monto' => $cuota];
    }],

  'presupuesto' => ['perm' => 'capturar', 'columnas' => [
      'partida' => ['codigo', 'partida', 'cuenta', 'clasificacion presupuestal', 'concepto', 'rubro', 'clasificacion'],
      'tipo_gasto' => ['tipo', 'tipo de gasto', 'fijo variable', 'fijo o variable'],
      'anual' => ['anual', 'total', 'total anual', 'importe anual', 'presupuesto anual'], 'mensual' => ['mensual', 'importe mensual', 'monto mensual']] + $mesesCols,
    'req' => ['partida'],
    'prep' => function (Ctx $ctx, object $aux) {
      $p = $ctx->db->prepare('SELECT * FROM presupuestos WHERE id = ? AND condominio_id = ?')->get($aux->presupuestoId, $ctx->cid) ?? fail(404, 'Presupuesto no encontrado.');
      if ($p['estado'] !== 'borrador') fail(409, 'Solo se importa a un presupuesto en borrador.');
      $aux->vistas = [];
    },
    'fila' => function (Ctx $ctx, array $r, object $aux) {
      $k = buscarPartida($aux, $r['partida'] ?? '', $ctx) ?? fail(400, 'Falta la partida.');
      if (isset($aux->vistas[$k['id']])) fail(400, "La partida {$k['codigo']} aparece dos veces en el archivo.");
      $ms = array_map(fn($i) => $r['m' . ($i + 1)] ?? '', range(0, 11));
      if (some($ms, fn($x) => txt($x) !== '')) $montos = array_map(fn($x, $i) => importe($x, false, MESES_IMP[$i][1]) ?? 0, $ms, range(0, 11));
      elseif (txt($r['mensual'] ?? '') !== '') $montos = array_fill(0, 12, importe($r['mensual'], false, 'Mensual'));
      elseif (txt($r['anual'] ?? '') !== '') $montos = prorratear(importe($r['anual'], false, 'Anual'), array_fill(0, 12, 1));
      else fail(400, 'Indique los importes por mes, mensual o anual.');
      $tg = norm($r['tipo_gasto'] ?? '');
      if ($tg !== '' && !preg_match('/^(f|fijo|v|variable)$/', $tg)) fail(400, 'Tipo de gasto: escriba Fijo o Variable.');
      if ($tg !== '') $ctx->db->prepare('UPDATE cuentas SET tipo_gasto = ? WHERE id = ?')->run($tg[0] === 'f' ? 'fijo' : 'variable', $k['id']);
      guardarLineasPresupuesto($ctx->db, $ctx->cid, $aux->presupuestoId, array_map(fn($m, $i) => ['cuenta_id' => $k['id'], 'mes' => $i + 1, 'monto_cents' => $m], $montos, range(0, 11)));
      $aux->vistas[$k['id']] = true;
      $total = array_sum($montos);
      return ['accion' => 'actualizado', 'detalle' => "{$k['codigo']} · {$k['nombre']} · " . pesosTxt($total) . ' anual' . (!empty($k['nueva']) ? ' · partida nueva' : ''), 'monto' => $total];
    }],
  ];
}

function mapear(array $enc, array $T): array {
  $mapa = []; $usados = [];
  $hs = array_map('norm', $enc);
  foreach (['exacta', 'prefijo'] as $pasada) foreach ($T['columnas'] as $k => $sin) {
    if (isset($mapa[$k])) continue;
    foreach ($hs as $j => $h) {
      if ($h === '' || isset($usados[$j])) continue;
      if (some($sin, fn($s) => $pasada === 'exacta' ? $h === $s : (str_starts_with($h, $s . ' ') || str_ends_with($h, ' ' . $s)))) { $mapa[$k] = $j; $usados[$j] = true; break; }
    }
  }
  $ign = []; foreach ($enc as $i => $h) if (txt($h) !== '' && !isset($usados[$i])) $ign[] = txt($h);
  return ['mapa' => $mapa, 'ignoradas' => $ign];
}

function importar(Ctx $ctx, string $tipo, array $body, array $perms, callable $rolPuede): array {
  $T = tiposImp()[$tipo] ?? fail(404, 'Tipo de importación desconocido.');
  if (!in_array($ctx->rol, $perms[$T['perm']], true)) fail(403, 'No tiene permiso para esta importación.');
  $b = v($body, ['filas' => 'arr', 'aplicar' => 'bool', 'archivo' => 'str|opt|max160']);
  $op = is_array($body['opciones'] ?? null) ? $body['opciones'] : [];
  $filas = array_map(fn($f) => is_array($f) ? array_map(fn($c) => esNum($c) ? $c : mslice(txt($c), 0, 400), array_slice(array_values($f), 0, 80)) : [], $b['filas']);
  $h = -1; $m = null;
  for ($i = 0; $i < min(15, count($filas)); $i++) { $r = mapear($filas[$i], $T); if (every($T['req'], fn($k) => isset($r['mapa'][$k]))) { $h = $i; $m = $r; break; } }
  if ($h < 0) fail(400, 'No se encontró el renglón de encabezados. Columnas obligatorias: ' . implode(', ', array_map(fn($k) => $T['columnas'][$k][0], $T['req'])) . '. Descargue la plantilla para ver el formato.');
  $ejemplos = 0; $datos = [];
  foreach (array_slice($filas, $h + 1) as $i => $arr) {
    $r = []; foreach ($m['mapa'] as $k => $j) $r[$k] = $arr[$j] ?? '';
    if (some($arr, 'esEjemplo')) { $ejemplos++; continue; }
    if (!some($r, fn($c) => txt($c) !== '') || (isset($T['vacia']) && $T['vacia']($r))) continue;
    $datos[] = ['n' => $h + $i + 2, 'r' => $r];
  }
  if (!$datos) fail(400, $ejemplos ? 'El archivo solo trae las filas de ejemplo: capture sus datos debajo de ellas (o sobre ellas, borrando la marca «EJEMPLO»).' : 'El archivo no tiene filas con datos debajo de los encabezados.');
  $db = $ctx->db; $res = [];
  $db->exec('BEGIN IMMEDIATE');
  try {
    $cat = catalogosImp($db, $ctx->cid);
    $aux = (object)($cat + ['creadas' => [], 'confirmarDuplicados' => !empty($op['confirmar_duplicados']), 'registrarPago' => !empty($op['registrar_pago']),
      'crearPartidas' => !empty($op['crear_partidas']) && $rolPuede('config'), 'presupuestoId' => (int)($op['presupuesto_id'] ?? 0) ?: null,
      'fechaCorte' => $tipo === 'saldos' ? v(['f' => $op['fecha_corte'] ?? null], ['f' => 'date'])['f'] : null, 'bancoDefecto' => null, 'partidaDefecto' => null]);
    $aux->unidad = new Buscador($cat['unidades'], fn($x) => [$x['clave'], $x['referencia'], $x['torre'] ? "{$x['torre']} {$x['clave']}" : null]);
    $aux->banco = new Buscador($cat['bancos'], fn($x) => [$x['codigo'], "{$x['banco']} {$x['nombre']}"]);
    $aux->partida = new Buscador($cat['partidas'], fn($x) => [$x['codigo'], $x['nombre'], "{$x['codigo']} {$x['nombre']}"]);
    if (!empty($op['cuenta_banco_id'])) $aux->bancoDefecto = find($cat['bancos'], fn($x) => $x['id'] === (int)$op['cuenta_banco_id']) ?? fail(400, 'Cuenta bancaria por defecto inválida.');
    if (!empty($op['partida_id'])) $aux->partidaDefecto = find($cat['partidas'], fn($x) => $x['id'] === (int)$op['partida_id']) ?? fail(400, 'Partida por defecto inválida.');
    if ($aux->fechaCorte && $aux->fechaCorte > hoy()) fail(400, 'La fecha de corte no puede ser futura.');
    if (isset($T['prep'])) $T['prep']($ctx, $aux, array_column($datos, 'r'));
    $veces = [];
    $ocurr = function ($base) use (&$veces) { $veces[$base] = ($veces[$base] ?? 0) + 1; return $veces[$base]; };
    foreach ($datos as ['n' => $n, 'r' => $r]) {
      $db->exec('SAVEPOINT fila');
      try { $out = $T['fila']($ctx, $r, $aux, $ocurr); $db->exec('RELEASE fila'); $res[] = ['n' => $n, 'ok' => true] + $out; }
      catch (Throwable $e) {
        $db->exec('ROLLBACK TO fila'); $db->exec('RELEASE fila');
        $err = $e instanceof AppError ? $e : dbError($e);
        if (!$err) throw $e;
        $res[] = ['n' => $n, 'ok' => false, 'error' => $err->getMessage(), 'code' => $err->codigo];
      }
    }
    $ok = filt($res, fn($r) => $r['ok']);
    $resumen = ['filas' => count($res), 'validas' => count(filt($ok, fn($r) => $r['accion'] !== 'omitido')), 'omitidas' => count(filt($res, fn($r) => ($r['accion'] ?? null) === 'omitido')),
      'errores' => count($res) - count($ok), 'creados' => count(filt($res, fn($r) => ($r['accion'] ?? null) === 'creado')), 'actualizados' => count(filt($res, fn($r) => ($r['accion'] ?? null) === 'actualizado')),
      'total_cents' => suma(filt($ok, fn($r) => !empty($r['monto'])), 'monto'), 'partidas_nuevas' => $aux->creadas, 'proveedores_nuevos' => $aux->provNuevos ?? [], 'ejemplos' => $ejemplos];
    $aplicar = $b['aplicar'] && $resumen['validas'] > 0;
    if ($aplicar) {
      audit($db, ['usuario_id' => $ctx->user['id'], 'condominio_id' => $ctx->cid, 'ip' => $ctx->ip, 'accion' => "importacion_{$tipo}", 'entidad' => 'importacion',
        'detalle' => ['archivo' => $b['archivo'], 'filas' => $resumen['filas'], 'aplicadas' => $resumen['validas'], 'omitidas' => $resumen['omitidas'], 'errores' => $resumen['errores'], 'total_cents' => $resumen['total_cents']]]);
      $db->exec('COMMIT');
    } else $db->exec('ROLLBACK');
    $cols = []; foreach ($m['mapa'] as $k => $j) $cols[$k] = txt($filas[$h][$j]);
    return ['aplicado' => $aplicar, 'encabezado' => $h + 1, 'columnas' => obj($cols), 'ignoradas' => $m['ignoradas'], 'resumen' => $resumen, 'filas' => $res];
  } catch (Throwable $e) { try { $db->exec('ROLLBACK'); } catch (Throwable) {} throw $e; }
}

function catalogosPlantilla(DB $db, int $cid): array {
  $c = catalogosImp($db, $cid);
  $per = fn($rol, $campo, $concat = false) => $concat
    ? "(SELECT GROUP_CONCAT(nombre, ', ') FROM (SELECT p.nombre FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = '$rol' ORDER BY up.id))"
    : "(SELECT p.$campo FROM unidad_personas up JOIN personas p ON p.id = up.persona_id WHERE up.unidad_id = u.id AND up.rol = '$rol' AND p.$campo IS NOT NULL LIMIT 1)";
  return [
    'unidades' => $db->prepare('SELECT u.clave, u.torre, u.referencia, u.tipo, u.m2, u.indiviso_ppm, u.cuota_cents, u.estado, u.activo, u.notas, ' . $per('propietario', '', true) . ' AS propietario, '
      . $per('propietario', 'email') . ' AS email, ' . $per('propietario', 'telefono') . ' AS telefono, ' . $per('propietario', 'rfc') . ' AS rfc, ' . $per('inquilino', '', true) . ' AS inquilino, '
      . $per('inquilino', 'email') . ' AS email_inq, ' . $per('inquilino', 'telefono') . ' AS tel_inq FROM unidades u WHERE u.condominio_id = ? ORDER BY u.torre, u.clave')->all($cid),
    'bancos' => array_map(fn($b) => ['codigo' => $b['codigo'], 'nombre' => "{$b['banco']} {$b['nombre']}", 'numero' => $b['numero_mask'], 'fondo' => $b['fondo'], 'id' => $b['id']], $c['bancos']),
    'partidas' => $c['partidas'],
    'proveedores' => $db->prepare('SELECT nombre, rfc, giro, email, telefono FROM proveedores WHERE condominio_id = ? AND activo = 1 ORDER BY nombre')->all($cid),
    'fondos' => col($db->prepare('SELECT nombre FROM fondos WHERE condominio_id = ? AND activo = 1 ORDER BY nombre')->all($cid), 'nombre'),
  ];
}
