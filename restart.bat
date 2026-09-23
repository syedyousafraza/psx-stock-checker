@echo off
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\nodejs\node.exe" C:\casino\startup.js
