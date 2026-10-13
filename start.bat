@echo off
REM Verbil one-click start: local blockchain + API/UI
cd /d %~dp0
set HARDHAT_DISABLE_TELEMETRY_PROMPT=true
if not exist ".venv\Scripts\python.exe" (
  echo First run on this machine: running setup.bat ...
  call setup.bat || exit /b 1
)
if not exist "chain\artifacts\contracts\InvoiceRegistry.sol\InvoiceRegistry.json" (
  pushd chain
  call npx hardhat compile
  popd
)
start "Verbil chain (Hardhat)" cmd /k "cd chain && npx hardhat node --port 8545"
echo Waiting for the chain to come up...
timeout /t 6 /nobreak >nul
start "Verbil app" cmd /k ".venv\Scripts\python -m uvicorn main:app --app-dir backend --port 8000"
timeout /t 4 /nobreak >nul
start http://localhost:8000
