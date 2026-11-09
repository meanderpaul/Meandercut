@echo off
title Build MeanderCut installer
cd /d "%~dp0"
if not exist node_modules call npm install
echo Building the Windows installer and portable .exe into the dist folder...
call npm run dist
if errorlevel 1 ( pause & exit /b 1 )
start "" "%~dp0dist"
