@echo off
taskkill /F /IM node.exe >nul 2>&1
timeout /t 5 /nobreak >nul
cd /d C:\casino
set VITE_PORT=5175
set PORT=8787
node startup.js
