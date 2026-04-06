@echo off
chcp 65001 >nul 2>&1
REM ============================================================================
REM  Шаблон: проверка выгрузки матрицы через ibcmd (загрузка XML в файловую ИБ).
REM  Скопируйте в ibcmd-local.bat, поправьте пути, запускайте ibcmd-local.bat
REM  (ibcmd-local.bat в .gitignore — не коммитить свои пути).
REM
REM  Шаг 1 — один раз сгенерировать YAML под ВАШ каталог файловой базы
REM  (тот же путь, что в конфигураторе: File="C:\...\InfoBase11"):
REM
REM    "C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe" server config init ^
REM      --database-path="C:\Users\%USERNAME%\Documents\InfoBase11" ^
REM      --name=CDT_matrix_smoke ^
REM      --out="%USERPROFILE%\Documents\1cviewer-ibcmd-infobase.yml"
REM
REM  Без --dbms используется файловая БД (см. справку: ibcmd help server).
REM
REM  Шаг 2 — переменные для instrument-smoke / matrix-local:
REM ============================================================================

set "IBCMD_PATH=C:\Program Files\1cv8\8.3.27.1859\bin\ibcmd.exe"
REM В .bat не использовать кириллицу в путях — cmd портит её для процессов Node.
set "IBCMD_INFOBASE_CONFIG=%USERPROFILE%\Documents\1cviewer-ibcmd-infobase.yml"

REM По необходимости учётная запись 1С (если ibcmd потребует):
REM set "IBCMD_USER=Администратор"
REM set "IBCMD_PASSWORD="

REM Быстрее полный прогон без окна VS Code:
set "SKIP_VSCODE_SMOKE=1"

cd /d "%~dp0"
call scripts\instrument-smoke.bat
exit /b %ERRORLEVEL%
