@echo off
setlocal

cd /d D:\work\Message-Automation\automation-system

set ENABLE_WHATSAPP=true
set ENABLE_WORKER=true
set ENABLE_SCHEDULER=false
set NODE_ENV=production

call C:\Users\Ganesh\AppData\Roaming\npm\pm2.cmd resurrect
if errorlevel 1 (
  call C:\Users\Ganesh\AppData\Roaming\npm\pm2.cmd start backend/app.js --name wa-sender --update-env
)

call C:\Users\Ganesh\AppData\Roaming\npm\pm2.cmd save

endlocal
