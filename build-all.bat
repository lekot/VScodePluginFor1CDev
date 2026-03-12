@echo off
echo Reading current version...
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"version\"" package.json') do set VERSION=%%~a

echo Current version: %VERSION%

echo Incrementing version...
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));const v=p.version.split('.');let major=parseInt(v[0]), minor=parseInt(v[1]), patch=parseInt(v[2]);if(patch>=9){minor++;patch=0;}else{patch++;}p.version=[major,minor,patch].join('.');fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"version\"" package.json') do set NEWVERSION=%%~a
echo New version: %NEWVERSION%

echo Compiling TypeScript...
node node_modules/typescript/bin/tsc -p .
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building VSIX package...
node node_modules/@vscode/vsce/vsce package
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo Build complete! VSIX: 1c-metadata-tree-vscode-%NEWVERSION%.vsix
echo Install via: Extensions: Install from VSIX...
