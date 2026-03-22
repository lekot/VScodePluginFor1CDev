@echo off
REM Best-effort removal of directories under %%TEMP%% created by tests (mkdtemp prefix 1cviewer-*).
REM Locked folders may remain until the next run or after processes exit.
setlocal
for /d %%i in ("%TEMP%\1cviewer-*") do rmdir /s /q "%%i" 2>nul
endlocal
exit /b 0
