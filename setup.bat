@echo off
title MeanderCut setup
cd /d "%~dp0"
echo.
echo  MeanderCut setup
echo  ================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found.
  echo  Install the LTS version from https://nodejs.org then run this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo  Found Node.js %%v
echo.
echo  Installing Electron and FFmpeg (one time, about 300 MB)...
call npm install
if errorlevel 1 (
  echo.
  echo  npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo.
echo  Done. Starting MeanderCut...
call npm start
