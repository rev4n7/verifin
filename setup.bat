@echo off
REM Verbil one-time setup: Python packages, Hardhat, contract compile
cd /d %~dp0
set HARDHAT_DISABLE_TELEMETRY_PROMPT=true
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv || goto :err
)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt || goto :err
pushd chain
call npm install || (popd & goto :err)
call npx hardhat compile || (popd & goto :err)
popd
echo.
echo Setup complete. Run start.bat to launch Verbil.
exit /b 0
:err
echo.
echo Setup failed. Check that Python 3.12+ and Node.js 18+ are installed and on PATH.
exit /b 1
