@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing required libraries, this only happens once...
  call npm install --no-fund --no-audit
)
echo Starting Shopify Bulk Uploader. Keep this window open while you work.
node src\server.js
pause
