@echo off
REM Полный instrument-smoke: core, матрица (полный обход), ibcmd, VS Code smoke.
REM Файл в UTF-8 с BOM + chcp 65001 — корректные пути с кириллицей в set.
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe"
set "IBCMD_INFOBASE_CONFIG=C:\Users\Максим\Documents\1cviewer-ibcmd-infobase.yml"

REM Импорт ibcmd может ругаться на часть XML матрицы — не обрывать полный прогон:
set "INSTRUMENT_IBCMD_NONFATAL=1"

REM Полный первый проход матрицы (все типовые узлы):
set "MATRIX_FULL=1"
REM Сброс среза из родительского shell (иначе реквизиты под Matrix_* не гоняются):
set "MATRIX_SLICE_LIMIT="
REM Второй проход: реквизиты и табличные части под объектами Matrix_* (см. shouldRunNestedMatrixPass):
set "MATRIX_NESTED=1"

set "SKIP_VSCODE_SMOKE="

call instrument-smoke.bat
endlocal
exit /b %ERRORLEVEL%
