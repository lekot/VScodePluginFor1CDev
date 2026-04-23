@echo off
setlocal

:: -----------------------------------------------------------------------
:: sync-cc-1c-skills.bat
:: Copies vendored files from cc-1c-skills upstream into resources/.
:: Usage: sync-cc-1c-skills.bat [CC_1C_SKILLS_DIR]
:: Default upstream dir: C:\reps\cc-1c-skills
:: -----------------------------------------------------------------------

if not "%~1"=="" set CC_1C_SKILLS_DIR=%~1
if "%CC_1C_SKILLS_DIR%"=="" set CC_1C_SKILLS_DIR=C:\reps\cc-1c-skills

:: Resolve script dir so we can find resources relative to repo root
set SCRIPT_DIR=%~dp0
set REPO_ROOT=%SCRIPT_DIR%..
set RESOURCES_DIR=%REPO_ROOT%\resources

echo [sync] Upstream: %CC_1C_SKILLS_DIR%

if not exist "%CC_1C_SKILLS_DIR%\" (
    echo [ERROR] Upstream directory not found: %CC_1C_SKILLS_DIR%
    echo         Set CC_1C_SKILLS_DIR environment variable or pass path as first argument.
    exit /b 1
)

:: -----------------------------------------------------------------------
:: Copy web-test scripts
:: -----------------------------------------------------------------------
set SRC_WT=%CC_1C_SKILLS_DIR%\.claude\skills\web-test\scripts
set DST_WT=%RESOURCES_DIR%\web-test

if not exist "%DST_WT%\" mkdir "%DST_WT%"

copy /y "%SRC_WT%\browser.mjs"       "%DST_WT%\browser.mjs"       >nul || goto :copy_error
copy /y "%SRC_WT%\dom.mjs"           "%DST_WT%\dom.mjs"           >nul || goto :copy_error
copy /y "%SRC_WT%\run.mjs"           "%DST_WT%\run.mjs"           >nul || goto :copy_error
copy /y "%SRC_WT%\package.json"      "%DST_WT%\package.json"      >nul || goto :copy_error
copy /y "%SRC_WT%\package-lock.json" "%DST_WT%\package-lock.json" >nul || goto :copy_error

echo [sync] web-test: 5 files OK

:: -----------------------------------------------------------------------
:: Copy skd scripts
:: -----------------------------------------------------------------------
set DST_SKD=%RESOURCES_DIR%\skd

if not exist "%DST_SKD%\" mkdir "%DST_SKD%"

copy /y "%CC_1C_SKILLS_DIR%\.claude\skills\skd-compile\scripts\skd-compile.ps1" "%DST_SKD%\skd-compile.ps1" >nul || goto :copy_error
copy /y "%CC_1C_SKILLS_DIR%\.claude\skills\skd-info\scripts\skd-info.ps1"       "%DST_SKD%\skd-info.ps1"     >nul || goto :copy_error
copy /y "%CC_1C_SKILLS_DIR%\.claude\skills\skd-edit\scripts\skd-edit.ps1"       "%DST_SKD%\skd-edit.ps1"     >nul || goto :copy_error
copy /y "%CC_1C_SKILLS_DIR%\.claude\skills\skd-validate\scripts\skd-validate.ps1" "%DST_SKD%\skd-validate.ps1" >nul || goto :copy_error

echo [sync] skd: 4 files OK

:: -----------------------------------------------------------------------
:: Update UPSTREAM.md — commit hash and date
:: -----------------------------------------------------------------------
set UPSTREAM_MD=%RESOURCES_DIR%\UPSTREAM.md

:: Get current commit hash from upstream
for /f %%H in ('git -C "%CC_1C_SKILLS_DIR%" rev-parse HEAD 2^>nul') do set COMMIT=%%H
if "%COMMIT%"=="" (
    echo [WARN] Could not read git commit from upstream. UPSTREAM.md not updated.
    goto :done
)

:: Get today's date in YYYY-MM-DD format via PowerShell
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%D

:: Rewrite the Commit and Date lines in UPSTREAM.md using PowerShell
powershell -NoProfile -Command ^
    "(Get-Content '%UPSTREAM_MD%') ^
     -replace '(?<=\*\*Commit:\*\* ).*', '%COMMIT%' ^
     -replace '(?<=\*\*Date:\*\* ).*', '%TODAY%' ^
     | Set-Content '%UPSTREAM_MD%' -Encoding UTF8"

echo [sync] UPSTREAM.md updated (commit: %COMMIT%, date: %TODAY%)

:done
echo.
echo Sync OK -- проверь diff через git status
exit /b 0

:copy_error
echo [ERROR] Failed to copy file. Check that upstream paths exist.
exit /b 1
