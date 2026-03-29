@echo off
chcp 65001 >nul 2>&1
REM Opt-in real ibcmd deploy smoke: SMOKE_DEPLOY_BINDING=1, workspace=repo root, SMOKE_DEPLOY_INFOBASE_PATH / SMOKE_DEPLOY_IBCMD_YAML — см. instrument-smoke.bat.
call "%~dp0cleanup-1cviewer-temp.bat"
echo Running smoke tests...
echo Compiling extension ^(tsconfig.json^)...
node node_modules/typescript/bin/tsc -p .
if %errorlevel% neq 0 exit /b %errorlevel%
echo Compiling TypeScript with test config...
node node_modules/typescript/bin/tsc -p tsconfig.test.json
if %errorlevel% neq 0 exit /b %errorlevel%

echo Running VS Code smoke tests...
node out\test\runSmoke.js %*
if %errorlevel% neq 0 exit /b %errorlevel%

call "%~dp0cleanup-1cviewer-temp.bat"
echo Smoke tests completed successfully.

