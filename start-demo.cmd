@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 22 or later from https://nodejs.org & exit /b 1)
set MOCK_VISION=1
set HOST=127.0.0.1
node server/server.js
