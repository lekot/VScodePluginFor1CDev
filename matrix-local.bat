@echo off
chcp 65001 >nul 2>&1
REM Container matrix on YOUR Designer export + optional ibcmd (see test\runMatrixLocal.ts).
REM WARNING: matrix CREATES and DELETES files under MATRIX_WORK_DIR — use a COPY of the dump, not production.
REM Usage from repo root:
REM   set MATRIX_WORK_DIR=C:\path\to\configuration   (must contain Configuration.xml)
REM   set IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe
REM   set IBCMD_INFOBASE_CONFIG=C:\Users\You\AppData\Local\1cviewer\ibcmd-infobase.yml
REM   set MATRIX_FULL=1
REM   set MATRIX_REPORT_PATH=%CD%\out\test\reports\matrix-local.json
REM   matrix-local.bat

if "%MATRIX_WORK_DIR%"=="" (
  echo ERROR: Set MATRIX_WORK_DIR to the configuration root ^(folder with Configuration.xml^).
  echo Example: set MATRIX_WORK_DIR=%CD%\FormatSamples\empty_conf
  exit /b 2
)

echo Compiling TypeScript ^(test config^)...
node node_modules\typescript\bin\tsc -p tsconfig.test.json
if errorlevel 1 exit /b 1

echo Running matrix on: %MATRIX_WORK_DIR%
node out\test\runMatrixLocal.js
exit /b %ERRORLEVEL%
