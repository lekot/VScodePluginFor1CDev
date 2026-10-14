@echo off
REM Legacy compatibility wrapper. Global TEMP scavenging is disabled.
node "%~dp0cleanup-1cviewer-temp.js"
exit /b 0
