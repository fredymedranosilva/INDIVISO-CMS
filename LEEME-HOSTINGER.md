# Indiviso CMS en Hostinger

Hay dos versiones; use la que corresponda a su plan.

## A. Sin Node.js (planes Single / Premium / cualquier hosting con PHP) — `indiviso-cms-php.zip`

Requisitos: PHP 8.1 o superior (Hostinger trae 8.2/8.3) con SQLite. No necesita base de datos MySQL.

1. hPanel → **Archivos → Administrador de archivos** → entre a **public_html** del dominio.
2. Borre lo que haya (por ejemplo `default.php`).
3. Suba `indiviso-cms-php.zip` y use **Extraer** ahí mismo. En `public_html` deben quedar `index.html`, `api.php`, `.htaccess` y las carpetas `app`, `css`, `js`, `fonts`.
   - Si no ve `.htaccess`, active «Mostrar archivos ocultos»; es indispensable.
4. Abra su dominio. Aparece **Instalación**: escriba su nombre, correo y una contraseña de 12+ caracteres. Entra directo como superadministrador.
5. Si el dominio no tiene candado (https), actívelo en hPanel → **Seguridad → SSL**.

Los datos se guardan en `indiviso-datos`, junto a `public_html` (fuera del alcance de la web). Respalde esa carpeta; incluye las llaves `secreto.key` y `respaldo.key`.

**Actualizar:** suba el zip nuevo y extraiga encima. Sus datos no se tocan.

Si PHP es menor a 8.1: hPanel → **Avanzado → Configuración de PHP** → elija 8.2 o 8.3.

## B. Con Node.js (planes Business / Cloud) — `indiviso-cms-hostinger.zip`

hPanel → Agregar sitio web → **Node.js web app** → subir el zip · Node 22 o 24 · archivo de entrada `app.js` · desplegar. Al abrir el dominio aparece la misma pantalla de instalación.

## Empezar a cargar datos reales
1. **Administración general → Nuevo condominio**.
2. **Unidades → Importar directorio** (cada departamento con su **código único**).
3. **Unidades → Importar cuotas** (código + cuota mensual).
4. **Unidades → Saldos iniciales**, **Bancos**, **Presupuesto** (cada rubro con código y tipo **Fijo/Variable**).
5. **Cobranza → Importar pagos** o registrarlos a mano.

Después active la verificación en dos pasos en **Seguridad**.
