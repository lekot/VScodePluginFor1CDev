@echo off
REM Best-effort removal under TEMP from tests / extension snapshots.
REM Delegates to .js for reliable cross-shell execution (cmd, Git Bash, WSL).
node "%~dp0cleanup-1cviewer-temp.js"
exit /b 0
