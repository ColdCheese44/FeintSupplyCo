@echo off
REM Launches the FeintSupplyCo autonomous daemon from the project root, appending output to the log.
cd /d "%~dp0.."
npm run daemon >> "data\daemon.out.log" 2>&1
