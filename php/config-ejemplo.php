<?php
// Configuración opcional de Indiviso CMS (versión PHP). Para usarla, copie este archivo como «config.php» en la misma carpeta.
// Sin config.php el sistema funciona con los valores por omisión.
return [
  // Carpeta de datos (base, adjuntos, respaldos y llaves). Por omisión: una carpeta «indiviso-datos» junto a public_html,
  // fuera del alcance de la web. Si el hospedaje no lo permite, se usa «datos/» dentro de la app, protegida por .htaccess.
  // 'INDIVISO_DATA' => '/home/usuario/indiviso-datos',

  // Zona horaria para «hoy», vencimientos y cierres.
  'INDIVISO_TZ' => 'America/Mexico_City',
];
