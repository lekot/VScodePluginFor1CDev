@echo off
REM Best-effort removal under %%TEMP%% from tests / extension snapshots:
REM   1cviewer-*   — unit tests
REM   1cv-deploy-* — deployService tests (e.g. 1cv-deploy-block-new-*)
REM   1cv-deploy-snap-* — rare leftovers if process killed during deploy copy mode
REM   ibcmd-cli-* — ibcmdCliScript tests (or legacy if .skip removed)
REM   form-engine-save-* — formCommandEngine.test.ts (was leaking before fix)
REM Locked folders may remain until the next run or after processes exit.
setlocal
for /d %%i in ("%TEMP%\1cviewer-*") do rmdir /s /q "%%i" 2>nul
for /d %%i in ("%TEMP%\1cv-deploy-*") do rmdir /s /q "%%i" 2>nul
for /d %%i in ("%TEMP%\ibcmd-cli-*") do rmdir /s /q "%%i" 2>nul
for /d %%i in ("%TEMP%\form-engine-save-*") do rmdir /s /q "%%i" 2>nul
del /q "%TEMP%\1cviewer-ibcmd-*.yaml" 2>nul
endlocal
exit /b 0
