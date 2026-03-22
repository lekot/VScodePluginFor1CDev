@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
call "%~dp0cleanup-1cviewer-temp.bat"

REM ============================================================================
REM  Полный смокер инструмента CDT 41 (не «исторический» только-VS Code smoke):
REM   1) Core-тесты Node (runCore) — без дубля e2e-матрицы (она в шаге 2).
REM   2) Контейнерная матрица на свежей копии empty_conf + опционально ibcmd.
REM   3) Smoke в VS Code Extension Host (дерево, формы, команды).
REM
REM  ibcmd (после мутаций матрицы на диске):
REM    set IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe
REM    set IBCMD_INFOBASE_CONFIG=C:\path\to\infobase.yml
REM    YAML для файловой ИБ обычно создают один раз: ibcmd server config init
REM      --database-path="<каталог как в конфигураторе File=...>" --name=... --out=...
REM    Шаблон с комментариями: ibcmd.setup.example.bat → копия в ibcmd-local.bat
REM    (опционально IBCMD_USER, IBCMD_PASSWORD, IBCMD_TIMEOUT_MS — см. design §6.5)
REM    INSTRUMENT_IBCMD_NONFATAL=1 — при ошибке ibcmd не прерывать батник (фаза VS Code smoke всё равно выполнится).
REM
REM  Матрица (по умолчанию — полный обход; быстрый срез: задайте MATRIX_SLICE_LIMIT или MATRIX_FULL=0):
REM    set MATRIX_FULL=0
REM    set MATRIX_SLICE_LIMIT=10
REM  Второй проход (реквизиты/ТЧ под Matrix_*): при полном обходе включается сам; иначе set MATRIX_NESTED=1
REM
REM  Пропустить окно VS Code:
REM    set SKIP_VSCODE_SMOKE=1
REM
REM  Свой каталог выгрузки вместо копии empty_conf:
REM    set MATRIX_WORK_DIR=C:\копия\конфигурации
REM ============================================================================

echo [instrument-smoke] Compiling extension...
node node_modules\typescript\bin\tsc -p .
if errorlevel 1 exit /b 1

echo [instrument-smoke] Compiling tests...
node node_modules\typescript\bin\tsc -p tsconfig.test.json
if errorlevel 1 exit /b 1

echo [instrument-smoke] Copying test fixtures to out\test\fixtures...
node -e "require('fs').cpSync('test/fixtures','out/test/fixtures',{recursive:true,force:true})"
if errorlevel 1 exit /b 1

echo [instrument-smoke] Core tests (suite containerMatrix.e2e excluded — runs next with ibcmd^)...
set SKIP_CONTAINER_MATRIX_E2E=1
node out\test\runCore.js
if errorlevel 1 (
  set SKIP_CONTAINER_MATRIX_E2E=
  exit /b 1
)
set SKIP_CONTAINER_MATRIX_E2E=

if not defined MATRIX_REPORT_PATH set MATRIX_REPORT_PATH=%CD%\suite-reports\instrument-matrix.json
if exist "%MATRIX_REPORT_PATH%" del /f /q "%MATRIX_REPORT_PATH%"

REM Документ-регистратор из empty_conf (см. test/helpers/smokeIbcmdConstants.ts). Переопределите IBCMD_RECORDER_DOCUMENT для своей копии конфигурации.
if not defined IBCMD_RECORDER_DOCUMENT set "IBCMD_RECORDER_DOCUMENT=ДокументТестРаботает"

REM Полный обход целей матрицы, если не заданы ни срез, ни явный MATRIX_FULL (0 = только срез по умолчанию 5).
if not defined MATRIX_SLICE_LIMIT if not defined MATRIX_FULL set MATRIX_FULL=1

REM Своя копия конфигурации: задайте INSTRUMENT_MATRIX_WORK_DIR перед вызовом батника.
REM Иначе сбрасываем MATRIX_WORK_DIR, чтобы не подхватить мусор из родительского shell (иначе пишем в случайный каталог).
if defined INSTRUMENT_MATRIX_WORK_DIR (
  set "MATRIX_WORK_DIR=%INSTRUMENT_MATRIX_WORK_DIR%"
) else (
  set MATRIX_WORK_DIR=
)

echo [instrument-smoke] Matrix + ibcmd gate (temp copy of empty_conf, or INSTRUMENT_MATRIX_WORK_DIR^)...
node out\test\runInstrumentSmoke.js
if errorlevel 1 exit /b 1

if /i "%SKIP_VSCODE_SMOKE%"=="1" (
  echo [instrument-smoke] SKIP_VSCODE_SMOKE=1 — VS Code smoke skipped.
  goto :done
)

if not defined SUITE_REPORT_PATH_SMOKE set SUITE_REPORT_PATH_SMOKE=%CD%\suite-reports\instrument-vscode-smoke.json
if not defined MANDATORY_SUITES_SMOKE set MANDATORY_SUITES_SMOKE=suite/smoke/smoke.test.js
if exist "%SUITE_REPORT_PATH_SMOKE%" del /f /q "%SUITE_REPORT_PATH_SMOKE%"

echo [instrument-smoke] VS Code extension smoke...
node out\test\runSmoke.js %*
if errorlevel 1 exit /b 1

:done
call "%~dp0cleanup-1cviewer-temp.bat"
echo [instrument-smoke] Completed successfully.
endlocal
exit /b 0
