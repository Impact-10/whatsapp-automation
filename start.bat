@echo off
title Pet Clinic - WhatsApp Automation
echo.
echo  ============================================
echo    Pet Clinic WhatsApp Automation System
echo  ============================================
echo.
echo  Starting server... please wait.
echo  Press Ctrl+C to stop the server.
echo.

cd /d "D:\work\Message-Automation\automation-system"

:: Open browser after 4 seconds
start "" cmd /c "timeout /t 4 /nobreak >nul && start "" http://localhost:3000/admin?key=463724a775b3a9e340185440ded88186a32a5add959e0eb1d8154feb2563f17f"

:: Start the Node server (foreground — Ctrl+C stops it)
"D:\work\Message-Automation\tools\node20\node-v20.20.1-win-x64\node.exe" backend/app.js
