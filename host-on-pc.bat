@echo off
rem Hosts the recreatecraft server on this PC and gives you a public address for your friends (free, no account, no card).
rem Needs: Node.js (https://nodejs.org, LTS) and cloudflared (winget install Cloudflare.cloudflared).
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org then run this again. & pause & exit /b 1)
where cloudflared >nul 2>nul || (echo cloudflared is not installed. Run:  winget install Cloudflare.cloudflared   then open a NEW terminal and run this again. & pause & exit /b 1)

if not exist node_modules (call npm install || (echo npm install failed & pause & exit /b 1))
if not exist .next (call npm run build || (echo build failed & pause & exit /b 1))

rem The world is saved in world-data\ next to this file (the database is only used on Wasmer).
start "recreatecraft server" cmd /k "cd /d %~dp0 && npm start"
timeout /t 8 >nul

echo.
echo Look for a line like  https://something-random.trycloudflare.com  below.
echo Type that whole address in Multiplayer (you and your friends). It changes every time you start this script.
echo Keep both windows open while playing. Close them to stop the server.
echo.
cloudflared tunnel --url http://localhost:3000
pause
