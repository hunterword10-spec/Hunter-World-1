@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Instale o Node.js 22+ em https://nodejs.org & pause & exit /b)
if not exist node_modules call npm install
node server\server.js
pause
