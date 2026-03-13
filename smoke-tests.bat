@echo off
echo Running smoke tests...
echo Compiling TypeScript with test config...
node node_modules/typescript/bin/tsc -p tsconfig.test.json
if %errorlevel% neq 0 exit /b %errorlevel%

echo Running VS Code smoke tests...
node out\test\runSmoke.js %*
if %errorlevel% neq 0 exit /b %errorlevel%

echo Smoke tests completed successfully.

