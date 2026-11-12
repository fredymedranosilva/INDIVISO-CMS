# Indiviso CMS en Hostinger (versión vacía)

Paquete sin datos de demostración: al primer arranque solo existe el superadministrador que usted defina.

## Requisitos
- Plan de Hostinger con **Node.js web apps** (Business o Cloud).
- **Node.js 22** (22.13 o superior recomendado). No se necesita `npm install`: no hay dependencias.

## Pasos
1. hPanel → **Sitios web → Agregar sitio web → Node.js web app → Subir archivos** y suba `indiviso-cms-hostinger.zip`.
2. Configuración de despliegue:
   - Versión de Node: **22.x**
   - Archivo de entrada: **`server.js`**
   - Comando de compilación: ninguno
3. **Variables de entorno**:

   | Variable | Valor | Para qué |
   |---|---|---|
   | `INDIVISO_ADMIN_EMAIL` | su correo | Crea el superadministrador en el primer arranque |
   | `INDIVISO_ADMIN_PASSWORD` | (opcional) 12+ caracteres | Si no la pone, se genera una temporal (ver abajo) |
   | `INDIVISO_HOSTS` | `sudominio.com,www.sudominio.com` | Solo atiende peticiones a su dominio |
   | `INDIVISO_DATA` | ruta **absoluta** fuera de la app, p. ej. `/home/uXXXXXXX/indiviso-datos` | Base de datos, adjuntos y respaldos cifrados. Fuera de la carpeta de la app para que un nuevo despliegue no la borre |

   Ya vienen activas por `server.js`: `HOST=0.0.0.0`, `INDIVISO_HTTPS=1`, `INDIVISO_TRUST_PROXY=1`. Hostinger asigna `PORT`.
4. **Desplegar**. Abra su dominio y entre con el correo del paso 3.
   - Sin `INDIVISO_ADMIN_PASSWORD`: la contraseña temporal aparece en el registro (logs) de la app y en `INDIVISO_DATA/primer-acceso.txt`. Al entrar, el sistema pide cambiarla. Borre ese archivo después.
   - Con contraseña: quítela de las variables de entorno una vez que haya entrado.
5. Active la verificación en dos pasos en **Seguridad** y guarde sus códigos de respaldo.

## Empezar a cargar datos reales
1. **Administración general → Nuevo condominio**.
2. **Unidades → Importar directorio** (cada departamento con su **código único**).
3. **Unidades → Importar cuotas** (código + cuota mensual).
4. **Unidades → Saldos iniciales**, **Bancos**, **Presupuesto** (cada rubro con código y tipo **Fijo/Variable**).
5. Cobranza: **Importar pagos** desde Excel o registrar a mano.

Todas las plantillas de Excel se descargan desde el diálogo de importación, con ejemplos en amarillo.

## Importante
- **No suba la carpeta `data/`** de su computadora: el servidor crea su propia base vacía.
- Conserve `INDIVISO_DATA/secreto.key` y `respaldo.key`: sin ellas no se pueden leer los respaldos cifrados ni los secretos de 2FA.
- Para actualizar: suba el nuevo zip y vuelva a desplegar; los datos en `INDIVISO_DATA` se conservan.
- Respaldos: se generan solos (antes de cada cierre y periódicamente) en `INDIVISO_DATA`. Copie esa carpeta y las llaves a otro lugar con regularidad (Administrador de archivos de Hostinger). Restaurar: `node scripts/restaurar.mjs <archivo>`.
