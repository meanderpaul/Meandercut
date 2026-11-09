@echo off
cd /d "%~dp0"
if not exist node_modules (
  call setup.bat
  exit /b
)
call npm start
