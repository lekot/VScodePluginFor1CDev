@echo off
setlocal
chcp 65001 >nul 2>&1
call "%~dp0cleanup-1cviewer-temp.bat"
echo Compiling TypeScript with test config...
node node_modules/typescript/bin/tsc -p tsconfig.test.json
if %errorlevel% neq 0 exit /b %errorlevel%

echo Copying test fixtures...
xcopy /E /I /Y test\fixtures out\test\fixtures >nul

echo Running core test suites (non-VSCode runner)...
set IBCMD_TESTS=1
node out/test/runCore.js
if %errorlevel% neq 0 (
    set "__TS_EXIT=%errorlevel%"
    endlocal & exit /b %__TS_EXIT%
)

call "%~dp0cleanup-1cviewer-temp.bat"
echo Done!
endlocal & exit /b 0
