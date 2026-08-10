@echo off
rem open qq-bridge settings page
if exist "%~dp0bridge.exe" (
  start "" "%~dp0bridge.exe" --ui
) else (
  start "" cmd /k "cd /d %~dp0 && node bridge.js --ui"
)
