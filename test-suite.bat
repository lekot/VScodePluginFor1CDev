@echo off
setlocal
chcp 65001 >nul 2>&1
node "%~dp0scripts\cleanup-1cviewer-temp.js"
echo Compiling TypeScript with test config...
node node_modules/typescript/bin/tsc -p tsconfig.test.json
if %errorlevel% neq 0 exit /b %errorlevel%

echo Copying test fixtures...
xcopy /E /I /Y test\fixtures out\test\fixtures >nul

echo Running core test suites (non-VSCode runner)...
set IBCMD_TESTS=1
node out/test/runCore.js
if errorlevel 1 (
    set "__TS_EXIT=%errorlevel%"
    goto :core_tests_failed
)

node "%~dp0scripts\cleanup-1cviewer-temp.js"
echo Done!
endlocal & exit /b 0

:core_tests_failed
endlocal & exit /b %__TS_EXIT%
