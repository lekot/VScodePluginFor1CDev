@echo off
chcp 65001 >nul 2>&1
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

