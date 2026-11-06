@echo off
rem Indiviso CMS - doble clic para abrir en Windows.
cd /d "%~dp0"
if "%INDIVISO_DATA%"=="" set "INDIVISO_DATA=%USERPROFILE%\Indiviso-datos"
echo === Indiviso CMS ===
where node >nul 2>nul
if errorlevel 1 (
  echo Falta instalar Node.js ^(gratuito^). Instale la version LTS y vuelva a abrir este archivo.
  start "" "https://nodejs.org/es/download"
  pause
  exit /b 1
)
if not exist "%INDIVISO_DATA%\indiviso.db" (
  echo Primera vez: creando datos de demostracion...
  node server\seed.mjs 2>nul
)
echo.
echo Usuarios de prueba:
findstr "@" "%INDIVISO_DATA%\credenciales-demo.txt"
echo.
echo Abriendo http://localhost:4300 - NO cierre esta ventana mientras use Indiviso.
start "" "http://localhost:4300"
node server\index.mjs 2>nul
pause
